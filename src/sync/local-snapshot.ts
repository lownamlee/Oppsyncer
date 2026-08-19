import type { TFile, Vault } from "obsidian";
import { LocalFileState, LocalSnapshot } from "../model";
import { ObSyncerSettings } from "../settings/settings";
import { gitBlobSha } from "../hash";
import { mapLimit } from "../map-limit";
import { isIncludedPath } from "./path-filter";

const HASH_CONCURRENCY = 4;

interface FileFingerprint {
  size: number;
  mtime: number;
}

export interface LocalScanOptions {
  cachedFiles?: Record<string, LocalFileState>;
  forceHash?: boolean;
}

export async function scanLocalVault(
  vault: Vault,
  settings: ObSyncerSettings,
  options: LocalScanOptions = {},
): Promise<LocalSnapshot> {
  const vaultFiles = vault.getFiles();
  const visibleFiles = new Map(vaultFiles.map((file) => [file.path, file]));
  const paths = vaultFiles
    .map((file) => file.path)
    .filter((path) => isIncludedPath(
      path,
      settings.excludedPatterns,
      settings.syncObsidianConfig,
      vault.configDir,
    ));

  if (settings.syncObsidianConfig) {
    paths.push(...await listConfigFiles(vault, settings));
  }

  const files = [...new Set(paths)].sort((left, right) => left.localeCompare(right));
  const entries = await mapLimit(files, HASH_CONCURRENCY, async (path) =>
    readLocalFileState(
      vault,
      path,
      visibleFiles.get(path),
      options.cachedFiles?.[path],
      options.forceHash === true,
    ));

  const existing = entries.filter((entry): entry is LocalFileState => entry !== null);
  return {
    files: Object.fromEntries(existing.map((entry) => [entry.path, entry])),
  };
}

export async function scanLocalPaths(
  vault: Vault,
  settings: ObSyncerSettings,
  base: LocalSnapshot,
  paths: Iterable<string>,
): Promise<LocalSnapshot> {
  const files = { ...base.files };
  const uniquePaths = [...new Set(paths)].sort((left, right) => left.localeCompare(right));

  await mapLimit(uniquePaths, HASH_CONCURRENCY, async (path) => {
    if (!isIncludedPath(
      path,
      settings.excludedPatterns,
      settings.syncObsidianConfig,
      vault.configDir,
    )) {
      delete files[path];
      return;
    }

    const state = await readLocalFileState(vault, path, undefined, undefined, true);
    if (state) files[path] = state;
    else delete files[path];
  });

  return { files };
}

export function hasCompleteLocalIndex(
  localFiles: Record<string, LocalFileState>,
  baselineFiles: Record<string, string>,
): boolean {
  const localPaths = Object.keys(localFiles).sort();
  const baselinePaths = Object.keys(baselineFiles).sort();
  if (localPaths.length !== baselinePaths.length) return false;
  return localPaths.every(
    (path, index) =>
      path === baselinePaths[index] && localFiles[path].sha === baselineFiles[path],
  );
}

async function readLocalFileState(
  vault: Vault,
  path: string,
  visibleFile?: TFile,
  cached?: LocalFileState,
  forceHash = false,
): Promise<LocalFileState | null> {
  let stat: FileFingerprint | null = visibleFile?.stat ?? null;
  if (!stat) {
    const adapterStat = await vault.adapter.stat(path);
    if (!adapterStat || adapterStat.type !== "file") return null;
    stat = adapterStat;
  }

  if (
    !forceHash &&
    cached &&
    cached.size === stat.size &&
    cached.mtime === stat.mtime
  ) {
    return { ...cached, path };
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const before = stat;
    const bytes = new Uint8Array(await vault.adapter.readBinary(path));
    const after = await vault.adapter.stat(path);
    if (!after || after.type !== "file") return null;
    if (stableRead(before, after, bytes.byteLength)) {
      return {
        path,
        sha: await gitBlobSha(bytes),
        size: bytes.byteLength,
        mtime: after.mtime,
      };
    }
    stat = after;
  }

  throw new Error(`Local file changed repeatedly while scanning: ${path}`);
}

function stableRead(
  before: FileFingerprint,
  after: FileFingerprint,
  bytesRead: number,
): boolean {
  return (
    before.size === after.size &&
    before.mtime === after.mtime &&
    after.size === bytesRead
  );
}

async function listConfigFiles(
  vault: Vault,
  settings: ObSyncerSettings,
): Promise<string[]> {
  const root = vault.configDir;
  if (!await vault.adapter.exists(root)) return [];

  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    const listed = await vault.adapter.list(directory);
    for (const path of listed.files) {
      if (isIncludedPath(
        path,
        settings.excludedPatterns,
        settings.syncObsidianConfig,
        root,
      )) {
        files.push(path);
      }
    }
    for (const folder of listed.folders) {
      pending.push(folder);
    }
  }
  return files;
}

export function shaMap(snapshot: LocalSnapshot): Record<string, string> {
  return Object.fromEntries(
    Object.values(snapshot.files).map((file) => [file.path, file.sha]),
  );
}

export function shaMapsEqual(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const leftPaths = Object.keys(left).sort();
  const rightPaths = Object.keys(right).sort();
  if (leftPaths.length !== rightPaths.length) return false;
  return leftPaths.every(
    (path, index) => path === rightPaths[index] && left[path] === right[path],
  );
}
