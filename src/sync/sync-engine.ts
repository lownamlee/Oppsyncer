import { TFile, TFolder, Vault, normalizePath } from "obsidian";
import GitHubClient, {
  GitHubApiError,
  GitTreeEntry,
} from "../github/client";
import {
  LocalSnapshot,
  ObSyncerState,
  RemoteSnapshot,
  SyncOutcome,
  SyncTrigger,
} from "../model";
import { ObSyncerSettings, settingsAreConfigured } from "../settings/settings";
import { gitBlobSha } from "../hash";
import { mapLimit } from "../map-limit";
import { shortSha, sleep } from "../utils";
import { scanLocalVault, shaMap, shaMapsEqual } from "./local-snapshot";
import { assertSafeRemotePath, isIncludedPath } from "./path-filter";
import { decideSyncAction } from "./state-machine";

const TRANSFER_CONCURRENCY = 3;
const MAX_FILE_BYTES = 95 * 1024 * 1024;

interface CandidateCommit {
  commitSha: string;
  treeSha: string;
}

export interface SyncEngineOptions {
  vault: Vault;
  getSettings: () => ObSyncerSettings;
  getState: () => ObSyncerState;
  saveState: (state: ObSyncerState) => Promise<void>;
  setApplyingRemote: (applying: boolean) => void;
}

export default class SyncEngine {
  private readonly vault: Vault;
  private readonly getSettings: () => ObSyncerSettings;
  private readonly getState: () => ObSyncerState;
  private readonly saveState: (state: ObSyncerState) => Promise<void>;
  private readonly setApplyingRemote: (applying: boolean) => void;

  constructor(options: SyncEngineOptions) {
    this.vault = options.vault;
    this.getSettings = options.getSettings;
    this.getState = options.getState;
    this.saveState = options.saveState;
    this.setApplyingRemote = options.setApplyingRemote;
  }

  isIncluded(path: string): boolean {
    return this.isIncludedWithSettings(path, this.getSettings());
  }

  async testConnection(): Promise<string> {
    const settings = this.getSettings();
    if (!settingsAreConfigured(settings)) {
      throw new Error("Repository settings are incomplete.");
    }
    const repository = await new GitHubClient(settings).getRepository();
    if (!repository.private) {
      throw new Error("Refusing to synchronize notes with a public repository.");
    }
    return repository.fullName;
  }

  async sync(_trigger: SyncTrigger): Promise<SyncOutcome> {
    const settings = this.getSettings();
    if (!settingsAreConfigured(settings)) {
      throw new Error("ObSyncer is not configured.");
    }

    const client = new GitHubClient(settings);
    const repository = await client.getRepository();
    if (!repository.private) {
      throw new Error("Refusing to synchronize notes with a public repository.");
    }
    const state = this.getState();
    const local = await scanLocalVault(this.vault, settings);
    this.assertFileSizes(local);
    const localMap = shaMap(local);
    const remoteHead = await client.getBranchHead();
    const remote = remoteHead
      ? await client.getRemoteSnapshot(remoteHead)
      : null;
    if (remote) this.validateRemote(remote, settings);
    const remoteMap = remote ? this.includedRemoteMap(remote, settings) : {};

    const decision = decideSyncAction({
      baselineSha: state.baselineCommitSha,
      remoteSha: remoteHead,
      localEmpty: Object.keys(local.files).length === 0,
      localEqualsBaseline: shaMapsEqual(localMap, state.baselineFiles),
      localEqualsRemote: Boolean(remote && shaMapsEqual(localMap, remoteMap)),
    });

    switch (decision) {
      case "empty":
        return {
          kind: "empty",
          detail: "The repository and included vault content are both empty.",
        };
      case "initialize-remote":
        return this.initializeRemote(client, local, settings);
      case "adopt-remote":
        if (!remote) throw new Error("Remote snapshot disappeared during sync.");
        await this.materializeRemote(client, remote, local, settings);
        return { kind: "pulled" };
      case "record-remote-baseline":
        if (!remote) throw new Error("Remote snapshot disappeared during sync.");
        await this.recordBaseline(remote, remoteMap);
        return { kind: "baseline-recorded" };
      case "bootstrap-blocked":
        throw new Error(
          "Safe bootstrap stopped: the vault and repository are both populated and no common baseline exists. Use an empty repository or an empty vault.",
        );
      case "remote-missing":
        throw new Error(
          "The configured remote branch disappeared after synchronization was established. ObSyncer will not recreate it automatically.",
        );
      case "idle":
        return { kind: "idle" };
      case "push-local":
        if (!remote) throw new Error("Remote snapshot disappeared during sync.");
        return this.pushLocal(client, remote, local, settings);
      case "recover-and-adopt":
        if (!remote) throw new Error("Remote snapshot disappeared during sync.");
        return this.recoverAndAdopt(client, remote, local, settings);
    }
  }

  private async initializeRemote(
    client: GitHubClient,
    local: LocalSnapshot,
    settings: ObSyncerSettings,
  ): Promise<SyncOutcome> {
    const paths = Object.keys(local.files).sort();
    if (paths.length === 0) return { kind: "empty" };

    const firstPath = paths[0];
    const firstBytes = await this.readLocalAndVerify(firstPath, local.files[firstPath].sha);
    const initialSha = await client.createInitialFile(
      firstPath,
      firstBytes,
      `ObSyncer: initialize from ${settings.deviceName}`,
    );

    let head = await this.waitForBranchHead(client);
    if (!head) {
      const repository = await client.getRepository();
      if (repository.defaultBranch !== settings.githubBranch) {
        await client.createReference(settings.githubBranch, initialSha);
        head = await this.waitForBranchHead(client);
      }
    }
    if (!head) {
      throw new Error(
        `GitHub initialized a commit but branch ${settings.githubBranch} was not available.`,
      );
    }

    const initialRemote = await client.getRemoteSnapshot(head);
    this.validateRemote(initialRemote, settings);
    const candidate = await this.createSnapshotCommit(
      client,
      local,
      initialRemote,
      head,
      `ObSyncer: initial vault snapshot from ${settings.deviceName}`,
    );
    await client.updateMainWithoutForce(candidate.commitSha);
    await this.recordBaseline(
      {
        commitSha: candidate.commitSha,
        treeSha: candidate.treeSha,
      },
      shaMap(local),
    );
    return { kind: "initialized" };
  }

  private async pushLocal(
    client: GitHubClient,
    remote: RemoteSnapshot,
    local: LocalSnapshot,
    settings: ObSyncerSettings,
  ): Promise<SyncOutcome> {
    const candidate = await this.createSnapshotCommit(
      client,
      local,
      remote,
      remote.commitSha,
      `ObSyncer: sync from ${settings.deviceName}`,
    );

    try {
      await client.updateMainWithoutForce(candidate.commitSha);
    } catch (error) {
      if (!(error instanceof GitHubApiError) || ![409, 422].includes(error.status)) {
        throw error;
      }
      const recoveryRef = await this.createAndVerifyRecovery(
        client,
        candidate.commitSha,
        settings,
      );
      const latest = await this.requireLatestRemote(client, settings);
      await this.materializeRemote(client, latest, local, settings);
      return { kind: "recovered", recoveryRef };
    }

    await this.recordBaseline(
      {
        commitSha: candidate.commitSha,
        treeSha: candidate.treeSha,
      },
      shaMap(local),
    );
    return { kind: "pushed" };
  }

  private async recoverAndAdopt(
    client: GitHubClient,
    remote: RemoteSnapshot,
    local: LocalSnapshot,
    settings: ObSyncerSettings,
  ): Promise<SyncOutcome> {
    const state = this.getState();
    if (!state.baselineCommitSha) {
      throw new Error("Recovery requires an established baseline.");
    }

    let candidate: CandidateCommit;
    try {
      candidate = await this.createSnapshotCommit(
        client,
        local,
        remote,
        state.baselineCommitSha,
        `ObSyncer recovery: ${settings.deviceName}`,
      );
    } catch (error) {
      if (!(error instanceof GitHubApiError) || ![404, 422].includes(error.status)) {
        throw error;
      }
      candidate = await this.createSnapshotCommit(
        client,
        local,
        remote,
        remote.commitSha,
        `ObSyncer recovery after rewritten history: ${settings.deviceName}`,
      );
    }

    const recoveryRef = await this.createAndVerifyRecovery(
      client,
      candidate.commitSha,
      settings,
    );
    const latest = await this.requireLatestRemote(client, settings);
    await this.materializeRemote(client, latest, local, settings);
    return { kind: "recovered", recoveryRef };
  }

  private async createSnapshotCommit(
    client: GitHubClient,
    local: LocalSnapshot,
    remote: RemoteSnapshot,
    parentSha: string,
    message: string,
  ): Promise<CandidateCommit> {
    const settings = this.getSettings();
    const entries = await this.buildExactTreeEntries(client, local, remote, settings);
    const treeSha = await client.createTree(entries);
    const commitSha = await client.createCommit(treeSha, parentSha, message);
    return { commitSha, treeSha };
  }

  private async buildExactTreeEntries(
    client: GitHubClient,
    local: LocalSnapshot,
    remote: RemoteSnapshot,
    settings: ObSyncerSettings,
  ): Promise<GitTreeEntry[]> {
    const preserved = Object.values(remote.files)
      .filter((file) => !this.isIncludedWithSettings(file.path, settings))
      .map((file) => ({
        path: file.path,
        mode: file.mode,
        type: "blob" as const,
        sha: file.sha,
      }));

    const localFiles = Object.values(local.files).sort((left, right) =>
      left.path.localeCompare(right.path),
    );
    const uploaded = await mapLimit(
      localFiles,
      TRANSFER_CONCURRENCY,
      async (file): Promise<GitTreeEntry> => {
        const existing = remote.files[file.path];
        if (existing?.sha === file.sha) {
          return {
            path: file.path,
            mode: existing.mode === "100755" ? "100755" : "100644",
            type: "blob",
            sha: existing.sha,
          };
        }
        const bytes = await this.readLocalAndVerify(file.path, file.sha);
        return {
          path: file.path,
          mode: "100644",
          type: "blob",
          sha: await client.createBlob(bytes),
        };
      },
    );

    return [...preserved, ...uploaded].sort((left, right) =>
      left.path.localeCompare(right.path),
    );
  }

  private async createAndVerifyRecovery(
    client: GitHubClient,
    commitSha: string,
    settings: ObSyncerSettings,
  ): Promise<string> {
    const device = settings.deviceName
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "device";
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = `obsyncer-recovery/${device}/${timestamp}-${shortSha(commitSha)}`;

    let branch = base;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await client.createReference(branch, commitSha);
        break;
      } catch (error) {
        if (
          !(error instanceof GitHubApiError) ||
          ![409, 422].includes(error.status) ||
          attempt === 2
        ) {
          throw error;
        }
        branch = `${base}-${attempt + 2}`;
      }
    }

    const verifiedSha = await client.getReference(branch);
    if (verifiedSha !== commitSha) {
      throw new Error("Recovery branch verification failed; local files were not replaced.");
    }
    await this.saveState({
      ...this.getState(),
      lastRecoveryRef: branch,
    });
    return branch;
  }

  private async requireLatestRemote(
    client: GitHubClient,
    settings: ObSyncerSettings,
  ): Promise<RemoteSnapshot> {
    const head = await client.getBranchHead();
    if (!head) throw new Error("Remote branch disappeared after recovery.");
    const remote = await client.getRemoteSnapshot(head);
    this.validateRemote(remote, settings);
    return remote;
  }

  private async materializeRemote(
    client: GitHubClient,
    remote: RemoteSnapshot,
    localBefore: LocalSnapshot,
    settings: ObSyncerSettings,
  ): Promise<void> {
    const remoteIncluded = Object.values(remote.files)
      .filter((file) => this.isIncludedWithSettings(file.path, settings))
      .sort((left, right) => left.path.localeCompare(right.path));
    const changed = remoteIncluded.filter(
      (file) => localBefore.files[file.path]?.sha !== file.sha,
    );
    const downloads = await mapLimit(changed, TRANSFER_CONCURRENCY, async (file) => {
      if (file.size > MAX_FILE_BYTES) {
        throw new Error(`Remote file exceeds the 95 MB safety limit: ${file.path}`);
      }
      const bytes = await client.getBlobBytes(file.sha);
      if (bytes.byteLength > MAX_FILE_BYTES) {
        throw new Error(`Downloaded file exceeds the 95 MB safety limit: ${file.path}`);
      }
      const actualSha = await gitBlobSha(bytes);
      if (actualSha !== file.sha) {
        throw new Error(`Downloaded blob verification failed: ${file.path}`);
      }
      return { file, bytes };
    });

    const remotePaths = new Set(remoteIncluded.map((file) => file.path));
    const deletions = Object.keys(localBefore.files)
      .filter((path) => !remotePaths.has(path))
      .sort();

    const currentLocal = await scanLocalVault(this.vault, settings);
    if (!shaMapsEqual(shaMap(currentLocal), shaMap(localBefore))) {
      throw new Error(
        "Local files changed while the remote was downloading. Nothing was replaced; retrying will preserve the new edit if recovery is required.",
      );
    }

    this.setApplyingRemote(true);
    try {
      for (const { file, bytes } of downloads) {
        await this.ensureParentFolder(file.path);
        const exact = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer;
        const path = normalizePath(file.path);
        await this.writeLocalFile(path, exact);
      }
      for (const path of deletions) {
        await this.deleteLocalFile(normalizePath(path));
      }
    } finally {
      this.setApplyingRemote(false);
    }

    const verified = await scanLocalVault(this.vault, settings);
    const expected = this.includedRemoteMap(remote, settings);
    if (!shaMapsEqual(shaMap(verified), expected)) {
      throw new Error(
        "Vault verification after pull failed. The baseline was not advanced; retry sync.",
      );
    }
    await this.recordBaseline(remote, expected);
  }

  private async recordBaseline(
    remote: Pick<RemoteSnapshot, "commitSha" | "treeSha">,
    files: Record<string, string>,
  ): Promise<void> {
    await this.saveState({
      ...this.getState(),
      baselineCommitSha: remote.commitSha,
      baselineTreeSha: remote.treeSha,
      baselineFiles: { ...files },
      lastSuccessfulSyncAt: Date.now(),
    });
  }

  private includedRemoteMap(
    remote: RemoteSnapshot,
    settings: ObSyncerSettings,
  ): Record<string, string> {
    return Object.fromEntries(
      Object.values(remote.files)
        .filter((file) => this.isIncludedWithSettings(file.path, settings))
        .map((file) => [file.path, file.sha]),
    );
  }

  private validateRemote(remote: RemoteSnapshot, settings: ObSyncerSettings): void {
    const portablePaths = new Map<string, string>();
    for (const file of Object.values(remote.files)) {
      const path = assertSafeRemotePath(file.path);
      const portableKey = path.normalize("NFC").toLowerCase();
      const collision = portablePaths.get(portableKey);
      if (collision && collision !== path) {
        throw new Error(`Remote paths collide on a case-insensitive device: ${collision} and ${path}`);
      }
      portablePaths.set(portableKey, path);
      if (
        this.isIncludedWithSettings(path, settings) &&
        file.mode !== "100644" &&
        file.mode !== "100755"
      ) {
        throw new Error(`Unsupported remote file mode at ${path}: ${file.mode}`);
      }
    }
  }

  private isIncludedWithSettings(path: string, settings: ObSyncerSettings): boolean {
    return isIncludedPath(
      path,
      settings.excludedPatterns,
      settings.syncObsidianConfig,
      this.vault.configDir,
    );
  }

  private assertFileSizes(local: LocalSnapshot): void {
    const oversized = Object.values(local.files).find(
      (file) => file.size > MAX_FILE_BYTES,
    );
    if (oversized) {
      throw new Error(`Local file exceeds the 95 MB safety limit: ${oversized.path}`);
    }
  }

  private async readLocalAndVerify(path: string, expectedSha: string): Promise<Uint8Array> {
    const bytes = new Uint8Array(
      await this.vault.adapter.readBinary(normalizePath(path)),
    );
    const actualSha = await gitBlobSha(bytes);
    if (actualSha !== expectedSha) {
      throw new Error(`Local file changed while syncing: ${path}`);
    }
    return bytes;
  }

  private isConfigPath(path: string): boolean {
    const configDir = normalizePath(this.vault.configDir);
    const normalized = normalizePath(path);
    return normalized === configDir || normalized.startsWith(`${configDir}/`);
  }

  private async writeLocalFile(path: string, data: ArrayBuffer): Promise<void> {
    if (this.isConfigPath(path)) {
      const existing = await this.vault.adapter.stat(path);
      if (existing?.type === "folder") {
        throw new Error(`Cannot replace a folder with a file: ${path}`);
      }
      await this.vault.adapter.writeBinary(path, data);
      return;
    }

    const existing = this.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.vault.modifyBinary(existing, data);
    } else if (existing) {
      throw new Error(`Cannot replace a folder with a file: ${path}`);
    } else {
      await this.vault.createBinary(path, data);
    }
  }

  private async deleteLocalFile(path: string): Promise<void> {
    if (this.isConfigPath(path)) {
      const existing = await this.vault.adapter.stat(path);
      if (!existing) return;
      if (existing.type !== "file") {
        throw new Error(`Cannot delete a folder as though it were a file: ${path}`);
      }
      await this.vault.adapter.remove(path);
      return;
    }

    const existing = this.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.vault.delete(existing, true);
    } else if (existing) {
      throw new Error(`Cannot delete a folder as though it were a file: ${path}`);
    }
  }

  private async ensureParentFolder(path: string): Promise<void> {
    const segments = path.split("/").slice(0, -1);
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      const normalized = normalizePath(current);
      if (this.isConfigPath(normalized)) {
        const stat = await this.vault.adapter.stat(normalized);
        if (stat?.type === "file") {
          throw new Error(`Cannot create a folder over an existing file: ${current}`);
        }
        if (!stat) await this.vault.adapter.mkdir(normalized);
        continue;
      }
      const existing = this.vault.getAbstractFileByPath(normalized);
      if (existing instanceof TFile) {
        throw new Error(`Cannot create a folder over an existing file: ${current}`);
      }
      if (!existing) {
        await this.vault.createFolder(normalized);
      } else if (!(existing instanceof TFolder)) {
        throw new Error(`Unexpected vault entry at ${current}`);
      }
    }
  }

  private async waitForBranchHead(client: GitHubClient): Promise<string | null> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const head = await client.getBranchHead();
      if (head) return head;
      await sleep(300 * (attempt + 1));
    }
    return null;
  }
}
