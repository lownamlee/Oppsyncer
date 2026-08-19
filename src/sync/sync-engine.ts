import { TFile, TFolder, Vault, normalizePath } from "obsidian";
import GitHubClient, {
  CommitFileAddition,
  GitHubApiError,
  GitTreeEntry,
} from "../github/client";
import {
  LocalFileState,
  LocalSnapshot,
  ObSyncerState,
  RemoteFileState,
  RemoteSnapshot,
  SyncOutcome,
} from "../model";
import { ObSyncerSettings, settingsAreConfigured } from "../settings/settings";
import { gitBlobSha } from "../hash";
import { mapLimit } from "../map-limit";
import { shortSha, sleep, toArrayBuffer } from "../utils";
import {
  hasCompleteLocalIndex,
  scanLocalPaths,
  scanLocalVault,
  shaMap,
  shaMapsEqual,
} from "./local-snapshot";
import { assertSafeRemotePath, isIncludedPath } from "./path-filter";
import { decideSyncAction } from "./state-machine";

const TRANSFER_CONCURRENCY = 3;
const MAX_FILE_BYTES = 95 * 1024 * 1024;
const ATOMIC_COMMIT_MAX_BYTES = 4 * 1024 * 1024;
const ATOMIC_COMMIT_MAX_FILES = 100;
const VAULT_IDENTITY_PATH = ".obsyncer/vault.json";
const VAULT_IDENTITY_FORMAT = 1;

interface CandidateCommit {
  commitSha: string;
  treeSha: string;
}

interface VaultIdentity {
  format: number;
  vaultId: string;
  displayName: string;
  createdAt: string;
}

export interface SyncRequest {
  dirtyPaths?: string[];
  forceHash?: boolean;
  remoteHead?: string | null;
  remoteHeadWasChecked?: boolean;
}

export interface RemoteHeadCheck {
  changed: boolean;
  head: string | null;
}

export interface SyncEngineOptions {
  vault: Vault;
  trashFile: (file: TFile) => Promise<void>;
  getSettings: () => ObSyncerSettings;
  getState: () => ObSyncerState;
  saveState: (state: ObSyncerState) => Promise<void>;
  setApplyingRemote: (applying: boolean) => void;
  getLocalGeneration: () => number;
}

export default class SyncEngine {
  private readonly vault: Vault;
  private readonly trashFile: (file: TFile) => Promise<void>;
  private readonly getSettings: () => ObSyncerSettings;
  private readonly getState: () => ObSyncerState;
  private readonly saveState: (state: ObSyncerState) => Promise<void>;
  private readonly setApplyingRemote: (applying: boolean) => void;
  private readonly getLocalGeneration: () => number;
  private client: GitHubClient | null = null;
  private clientKey = "";

  constructor(options: SyncEngineOptions) {
    this.vault = options.vault;
    this.trashFile = options.trashFile;
    this.getSettings = options.getSettings;
    this.getState = options.getState;
    this.saveState = options.saveState;
    this.setApplyingRemote = options.setApplyingRemote;
    this.getLocalGeneration = options.getLocalGeneration;
  }

  isIncluded(path: string): boolean {
    return this.isIncludedWithSettings(path, this.getSettings());
  }

  async testConnection(): Promise<string> {
    const settings = this.getSettings();
    if (!settingsAreConfigured(settings)) {
      throw new Error("Repository settings are incomplete.");
    }
    const repository = await this.getClient(settings).getRepository();
    if (!repository.private) {
      throw new Error("Refusing to synchronize notes with a public repository.");
    }
    return repository.fullName;
  }

  async hasRemoteChange(): Promise<boolean> {
    return (await this.checkRemoteHead()).changed;
  }

  async checkRemoteHead(): Promise<RemoteHeadCheck> {
    const settings = this.getSettings();
    if (!settingsAreConfigured(settings)) return { changed: true, head: null };
    const state = this.getState();
    const remoteHead = await this.getClient(settings).getBranchHead();
    return {
      changed:
        !state.baselineCommitSha ||
        !state.baselineTreeSha ||
        !state.vaultId ||
        remoteHead !== state.baselineCommitSha,
      head: remoteHead,
    };
  }

  async sync(request: SyncRequest = {}): Promise<SyncOutcome> {
    const settings = this.getSettings();
    if (!settingsAreConfigured(settings)) {
      throw new Error("Oppsyncer is not configured.");
    }

    const client = this.getClient(settings);
    let state = this.getState();
    const repositoryPromise = client.getRepository();
    let remoteHead = request.remoteHeadWasChecked
      ? request.remoteHead ?? null
      : await client.getBranchHead();
    let remote: RemoteSnapshot | null = null;
    const needsRemoteSnapshot = Boolean(
      remoteHead &&
      (remoteHead !== state.baselineCommitSha ||
        !state.baselineTreeSha ||
        !state.vaultId),
    );
    const remotePromise = remoteHead && needsRemoteSnapshot
      ? client.getRemoteSnapshot(remoteHead)
      : Promise.resolve(null);
    const [repository, fetchedRemote] = await Promise.all([
      repositoryPromise,
      remotePromise,
    ]);
    if (!repository.private) {
      throw new Error("Refusing to synchronize notes with a public repository.");
    }

    if (fetchedRemote) {
      remote = fetchedRemote;
      this.validateRemote(remote, settings);
      remote = await this.ensureRemoteIdentity(client, remote, settings);
      remoteHead = remote.commitSha;
      state = this.getState();
    } else if (remoteHead) {
      remote = this.snapshotFromBaseline(state);
    }

    const remoteAdvanced = Boolean(
      state.baselineCommitSha && remoteHead !== state.baselineCommitSha,
    );
    const canIncrementallyScan = Boolean(
      request.dirtyPaths?.length &&
      !request.forceHash &&
      !remoteAdvanced &&
      remoteHead === state.baselineCommitSha &&
      hasCompleteLocalIndex(state.localFiles, state.baselineFiles),
    );
    const local = canIncrementallyScan
      ? await scanLocalPaths(
        this.vault,
        settings,
        { files: state.localFiles },
        request.dirtyPaths ?? [],
      )
      : await scanLocalVault(this.vault, settings, {
        cachedFiles: state.localFiles,
        forceHash: request.forceHash === true || remoteAdvanced,
      });

    this.assertFileSizes(local);
    const localMap = shaMap(local);
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
        await this.saveLocalIndex(local);
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
        await this.recordBaseline(remote, remoteMap, local);
        return { kind: "baseline-recorded" };
      case "bootstrap-blocked":
        throw new Error(
          "Safe bootstrap stopped: the vault and repository are both populated and no common baseline exists. Use an empty repository or an empty vault.",
        );
      case "remote-missing":
        throw new Error(
          "The configured remote branch disappeared after synchronization was established. Oppsyncer will not recreate it automatically.",
        );
      case "idle":
        await this.saveLocalIndex(local);
        return { kind: "idle" };
      case "push-local":
        if (!remote) throw new Error("Remote snapshot disappeared during sync.");
        return this.pushLocal(client, remote, local, settings);
      case "recover-and-adopt":
        if (!remote) throw new Error("Remote snapshot disappeared during sync.");
        return this.recoverAndAdopt(client, remote, local, settings);
    }
  }

  private getClient(settings: ObSyncerSettings): GitHubClient {
    const key = [
      settings.githubOwner,
      settings.githubRepo,
      settings.githubBranch,
      settings.githubToken,
    ].join("\0");
    if (!this.client || this.clientKey !== key) {
      this.client = new GitHubClient(settings);
      this.clientKey = key;
    }
    return this.client;
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
      `Oppsyncer: initialize from ${settings.deviceName}`,
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

    let initialRemote = await client.getRemoteSnapshot(head);
    this.validateRemote(initialRemote, settings);
    initialRemote = await this.ensureRemoteIdentity(client, initialRemote, settings);
    const candidate = await this.createSnapshotCommit(
      client,
      local,
      initialRemote,
      initialRemote.commitSha,
      `Oppsyncer: initial vault snapshot from ${settings.deviceName}`,
    );
    await client.updateMainWithoutForce(candidate.commitSha);
    await this.recordBaseline(
      {
        commitSha: candidate.commitSha,
        treeSha: candidate.treeSha,
      },
      shaMap(local),
      local,
    );
    return { kind: "initialized" };
  }

  private async pushLocal(
    client: GitHubClient,
    remote: RemoteSnapshot,
    local: LocalSnapshot,
    settings: ObSyncerSettings,
  ): Promise<SyncOutcome> {
    const atomicChanges = await this.buildAtomicCommitChanges(
      local,
      remote,
      settings,
    );
    if (atomicChanges) {
      try {
        const committed = await client.createCommitOnBranch(
          remote.commitSha,
          `Oppsyncer: sync from ${settings.deviceName}`,
          atomicChanges.additions,
          atomicChanges.deletions,
        );
        await this.recordBaseline(committed, shaMap(local), local);
        return { kind: "pushed" };
      } catch (error) {
        if (!(error instanceof GitHubApiError) || error.status !== 422) {
          throw error;
        }
        const candidate = await this.createSnapshotCommit(
          client,
          local,
          remote,
          remote.commitSha,
          `Oppsyncer recovery: ${settings.deviceName}`,
        );
        return this.recoverRejectedPush(client, candidate, local, settings);
      }
    }

    const candidate = await this.createSnapshotCommit(
      client,
      local,
      remote,
      remote.commitSha,
      `Oppsyncer: sync from ${settings.deviceName}`,
    );

    try {
      await client.updateMainWithoutForce(candidate.commitSha);
    } catch (error) {
      if (!(error instanceof GitHubApiError) || ![409, 422].includes(error.status)) {
        throw error;
      }
      return this.recoverRejectedPush(client, candidate, local, settings);
    }

    await this.recordBaseline(
      {
        commitSha: candidate.commitSha,
        treeSha: candidate.treeSha,
      },
      shaMap(local),
      local,
    );
    return { kind: "pushed" };
  }

  private async recoverRejectedPush(
    client: GitHubClient,
    candidate: CandidateCommit,
    local: LocalSnapshot,
    settings: ObSyncerSettings,
  ): Promise<SyncOutcome> {
    const recoveryRef = await this.createAndVerifyRecovery(
      client,
      candidate.commitSha,
      settings,
    );
    const latest = await this.requireLatestRemote(client, settings);
    await this.materializeRemote(client, latest, local, settings);
    return { kind: "recovered", recoveryRef };
  }

  private async buildAtomicCommitChanges(
    local: LocalSnapshot,
    parent: RemoteSnapshot,
    settings: ObSyncerSettings,
  ): Promise<{ additions: CommitFileAddition[]; deletions: string[] } | null> {
    const parentIncluded = Object.fromEntries(
      Object.values(parent.files)
        .filter((file) => this.isIncludedWithSettings(file.path, settings))
        .map((file) => [file.path, file]),
    );
    const changedLocal = Object.values(local.files)
      .filter((file) => parentIncluded[file.path]?.sha !== file.sha)
      .sort((left, right) => left.path.localeCompare(right.path));
    const deletions = Object.values(parentIncluded)
      .filter((file) => !local.files[file.path])
      .map((file) => file.path)
      .sort((left, right) => left.localeCompare(right));
    const fileCount = changedLocal.length + deletions.length;
    const additionBytes = changedLocal.reduce((total, file) => total + file.size, 0);
    if (
      fileCount === 0 ||
      fileCount > ATOMIC_COMMIT_MAX_FILES ||
      additionBytes > ATOMIC_COMMIT_MAX_BYTES
    ) {
      return null;
    }
    const additions = await mapLimit(
      changedLocal,
      TRANSFER_CONCURRENCY,
      async (file): Promise<CommitFileAddition> => ({
        path: file.path,
        contents: await this.readLocalAndVerify(file.path, file.sha),
      }),
    );
    return { additions, deletions };
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
      const baseline = this.snapshotFromBaseline(state);
      if (!baseline) throw new Error("Recovery baseline tree is unavailable.");
      candidate = await this.createSnapshotCommit(
        client,
        local,
        baseline,
        state.baselineCommitSha,
        `Oppsyncer recovery: ${settings.deviceName}`,
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
        `Oppsyncer recovery after rewritten history: ${settings.deviceName}`,
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
    parent: RemoteSnapshot,
    parentSha: string,
    message: string,
  ): Promise<CandidateCommit> {
    const settings = this.getSettings();
    const entries = await this.buildDeltaTreeEntries(client, local, parent, settings);
    if (entries.length === 0) {
      return { commitSha: parentSha, treeSha: parent.treeSha };
    }
    const treeSha = await client.createTree(entries, parent.treeSha);
    const commitSha = await client.createCommit(treeSha, parentSha, message);
    return { commitSha, treeSha };
  }

  private async buildDeltaTreeEntries(
    client: GitHubClient,
    local: LocalSnapshot,
    parent: RemoteSnapshot,
    settings: ObSyncerSettings,
  ): Promise<GitTreeEntry[]> {
    const parentIncluded = Object.fromEntries(
      Object.values(parent.files)
        .filter((file) => this.isIncludedWithSettings(file.path, settings))
        .map((file) => [file.path, file]),
    );
    const changedLocal = Object.values(local.files)
      .filter((file) => parentIncluded[file.path]?.sha !== file.sha)
      .sort((left, right) => left.path.localeCompare(right.path));

    const uploaded = await mapLimit(
      changedLocal,
      TRANSFER_CONCURRENCY,
      async (file): Promise<GitTreeEntry> => {
        const bytes = await this.readLocalAndVerify(file.path, file.sha);
        return {
          path: file.path,
          mode: "100644",
          type: "blob",
          sha: await client.createBlob(bytes),
        };
      },
    );

    const deleted = Object.values(parentIncluded)
      .filter((file) => !local.files[file.path])
      .map((file): GitTreeEntry => ({
        path: file.path,
        mode: file.mode === "100755" ? "100755" : "100644",
        type: "blob",
        sha: null,
      }));

    return [...uploaded, ...deleted].sort((left, right) =>
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
    let remote = await client.getRemoteSnapshot(head);
    this.validateRemote(remote, settings);
    remote = await this.ensureRemoteIdentity(client, remote, settings);
    return remote;
  }

  private async materializeRemote(
    client: GitHubClient,
    remote: RemoteSnapshot,
    localBefore: LocalSnapshot,
    settings: ObSyncerSettings,
  ): Promise<void> {
    const generationBeforeDownload = this.getLocalGeneration();
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

    if (this.getLocalGeneration() !== generationBeforeDownload) {
      throw new Error(
        "Local files changed while the remote was downloading. Nothing was replaced; retrying will preserve the new edit if recovery is required.",
      );
    }
    const currentLocal = await scanLocalVault(this.vault, settings, {
      cachedFiles: localBefore.files,
    });
    if (!shaMapsEqual(shaMap(currentLocal), shaMap(localBefore))) {
      throw new Error(
        "Local files changed while the remote was downloading. Nothing was replaced; retrying will preserve the new edit if recovery is required.",
      );
    }

    this.setApplyingRemote(true);
    try {
      for (const { file, bytes } of downloads) {
        await this.ensureParentFolder(file.path);
        await this.writeLocalFile(normalizePath(file.path), toArrayBuffer(bytes));
      }
      for (const path of deletions) {
        await this.deleteLocalFile(normalizePath(path));
      }
    } finally {
      this.setApplyingRemote(false);
    }

    const verificationPaths = [
      ...downloads.map(({ file }) => file.path),
      ...deletions,
    ];
    const verified = await scanLocalPaths(
      this.vault,
      settings,
      currentLocal,
      verificationPaths,
    );
    const expected = this.includedRemoteMap(remote, settings);
    if (!shaMapsEqual(shaMap(verified), expected)) {
      throw new Error(
        "Vault verification after pull failed. The baseline was not advanced; retry sync.",
      );
    }
    await this.recordBaseline(remote, expected, verified);
  }

  private async ensureRemoteIdentity(
    client: GitHubClient,
    remote: RemoteSnapshot,
    settings: ObSyncerSettings,
    attempt = 0,
  ): Promise<RemoteSnapshot> {
    const identityFile = remote.files[VAULT_IDENTITY_PATH];
    if (identityFile) {
      if (identityFile.size > 16 * 1024) {
        throw new Error("Remote Oppsyncer vault identity is unexpectedly large.");
      }
      const identityState = this.getState();
      if (
        identityState.vaultId &&
        identityState.vaultIdentityBlobSha === identityFile.sha
      ) {
        return remote;
      }
      const bytes = await client.getBlobBytes(identityFile.sha);
      const identity = parseVaultIdentity(new TextDecoder().decode(bytes));
      const localVaultId = identityState.vaultId;
      if (localVaultId && localVaultId !== identity.vaultId) {
        throw new Error(
          "This local vault is paired with a different Oppsyncer repository identity.",
        );
      }
      await this.saveState({
        ...this.getState(),
        vaultId: identity.vaultId,
        vaultIdentityBlobSha: identityFile.sha,
      });
      return remote;
    }

    const state = this.getState();
    const identity: VaultIdentity = {
      format: VAULT_IDENTITY_FORMAT,
      vaultId: state.vaultId ?? createId(),
      displayName: this.vault.getName(),
      createdAt: new Date().toISOString(),
    };
    const content = new TextEncoder().encode(`${JSON.stringify(identity, null, 2)}\n`);
    const blobSha = await client.createBlob(content);
    const treeSha = await client.createTree(
      [{
        path: VAULT_IDENTITY_PATH,
        mode: "100644",
        type: "blob",
        sha: blobSha,
      }],
      remote.treeSha,
    );
    const commitSha = await client.createCommit(
      treeSha,
      remote.commitSha,
      "Oppsyncer: establish vault identity",
    );

    try {
      await client.updateMainWithoutForce(commitSha);
    } catch (error) {
      if (
        attempt === 0 &&
        error instanceof GitHubApiError &&
        [409, 422].includes(error.status)
      ) {
        const latestHead = await client.getBranchHead();
        if (!latestHead) {
          throw Object.assign(
            new Error("Remote branch disappeared during vault pairing."),
            { cause: error },
          );
        }
        const latest = await client.getRemoteSnapshot(latestHead);
        this.validateRemote(latest, settings);
        return this.ensureRemoteIdentity(client, latest, settings, attempt + 1);
      }
      throw error;
    }

    await this.saveState({
      ...this.getState(),
      vaultId: identity.vaultId,
      vaultIdentityBlobSha: blobSha,
    });
    return {
      commitSha,
      treeSha,
      files: {
        ...remote.files,
        [VAULT_IDENTITY_PATH]: {
          path: VAULT_IDENTITY_PATH,
          mode: "100644",
          type: "blob",
          sha: blobSha,
          size: content.byteLength,
        },
      },
    };
  }

  private snapshotFromBaseline(state: ObSyncerState): RemoteSnapshot | null {
    if (!state.baselineCommitSha || !state.baselineTreeSha) return null;
    const files: Record<string, RemoteFileState> = Object.fromEntries(
      Object.entries(state.baselineFiles).map(([path, sha]) => [
        path,
        {
          path,
          mode: "100644",
          type: "blob",
          sha,
          size: state.localFiles[path]?.size ?? 0,
        },
      ]),
    );
    return {
      commitSha: state.baselineCommitSha,
      treeSha: state.baselineTreeSha,
      files,
    };
  }

  private async recordBaseline(
    remote: Pick<RemoteSnapshot, "commitSha" | "treeSha">,
    files: Record<string, string>,
    local: LocalSnapshot,
  ): Promise<void> {
    await this.saveState({
      ...this.getState(),
      baselineCommitSha: remote.commitSha,
      baselineTreeSha: remote.treeSha,
      baselineFiles: { ...files },
      localFiles: cloneLocalFiles(local.files),
      lastSuccessfulSyncAt: Date.now(),
    });
  }

  private async saveLocalIndex(local: LocalSnapshot): Promise<void> {
    await this.saveState({
      ...this.getState(),
      localFiles: cloneLocalFiles(local.files),
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
      await this.trashFile(existing);
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

function cloneLocalFiles(
  files: Record<string, LocalFileState>,
): Record<string, LocalFileState> {
  return Object.fromEntries(
    Object.entries(files).map(([path, file]) => [path, { ...file }]),
  );
}

function parseVaultIdentity(content: string): VaultIdentity {
  let candidate: unknown;
  try {
    candidate = JSON.parse(content);
  } catch {
    throw new Error("Remote Oppsyncer vault identity is not valid JSON.");
  }
  if (!candidate || typeof candidate !== "object") {
    throw new Error("Remote Oppsyncer vault identity is invalid.");
  }
  const value = candidate as Partial<VaultIdentity>;
  if (
    value.format !== VAULT_IDENTITY_FORMAT ||
    typeof value.vaultId !== "string" ||
    !/^[A-Za-z0-9-]{16,80}$/.test(value.vaultId) ||
    typeof value.displayName !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    throw new Error("Remote Oppsyncer vault identity has an unsupported format.");
  }
  return value as VaultIdentity;
}

function createId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random()
    .toString(36)
    .slice(2)}`;
}
