import { Vault } from "obsidian";
import { LocalSnapshot } from "../model";
import { gitBlobSha } from "../hash";
import { mapLimit } from "../utils";
import { isIncludedPath } from "./path-filter";

const HASH_CONCURRENCY = 4;

export async function scanLocalVault(
  vault: Vault,
  excludedPatterns: string[],
): Promise<LocalSnapshot> {
  const files = vault
    .getFiles()
    .filter((file) => isIncludedPath(file.path, excludedPatterns))
    .sort((left, right) => left.path.localeCompare(right.path));

  const entries = await mapLimit(files, HASH_CONCURRENCY, async (file) => {
    const bytes = new Uint8Array(await vault.readBinary(file));
    return {
      path: file.path,
      sha: await gitBlobSha(bytes),
      size: bytes.byteLength,
    };
  });

  return {
    files: Object.fromEntries(entries.map((entry) => [entry.path, entry])),
  };
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
