import type { Vault } from "obsidian";
import { LocalSnapshot } from "../model";
import { ObSyncerSettings } from "../settings/settings";
import { gitBlobSha } from "../hash";
import { mapLimit } from "../map-limit";
import { isIncludedPath } from "./path-filter";

const HASH_CONCURRENCY = 4;

export async function scanLocalVault(
  vault: Vault,
  settings: ObSyncerSettings,
): Promise<LocalSnapshot> {
  const paths = vault
    .getFiles()
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

  const entries = await mapLimit(files, HASH_CONCURRENCY, async (path) => {
    const bytes = new Uint8Array(await vault.adapter.readBinary(path));
    return {
      path,
      sha: await gitBlobSha(bytes),
      size: bytes.byteLength,
    };
  });

  return {
    files: Object.fromEntries(entries.map((entry) => [entry.path, entry])),
  };
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
      const normalized = path;
      if (isIncludedPath(
        normalized,
        settings.excludedPatterns,
        settings.syncObsidianConfig,
        root,
      )) {
        files.push(normalized);
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
