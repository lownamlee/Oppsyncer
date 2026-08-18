import { DEFAULT_EXCLUDED_PATTERNS } from "../settings/settings";

function configExclusions(configDir: string): string[] {
  return [
    `${configDir}/plugins/obsyncer/data.json*`,
    `${configDir}/workspace*.json`,
    `${configDir}/cache/**`,
    `${configDir}/file-recovery.json`,
    `${configDir}/sync.json`,
    `${configDir}/github-sync-metadata.json`,
    `${configDir}/github-sync.log`,
  ];
}

export function normalizeSafePath(input: string): string {
  if (input.includes("\\") || input.startsWith("./")) {
    throw new Error(`Unsafe vault path: ${input}`);
  }
  const normalized = input;
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.includes("\0")
  ) {
    throw new Error(`Unsafe vault path: ${input}`);
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Unsafe vault path: ${input}`);
  }
  for (const segment of segments) {
    if (
      /[<>:"|?*]/.test(segment) ||
      /[. ]$/.test(segment) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
    ) {
      throw new Error(`Path is not portable across desktop and mobile: ${input}`);
    }
  }
  return normalized;
}

export function isIncludedPath(
  path: string,
  userPatterns: string[],
  syncObsidianConfig = false,
  configDir = ".obsidian",
): boolean {
  let safePath: string;
  let safeConfigDir: string;
  try {
    safePath = normalizeSafePath(path);
    safeConfigDir = normalizeSafePath(configDir);
  } catch {
    return false;
  }

  const inConfigDir =
    safePath === safeConfigDir || safePath.startsWith(`${safeConfigDir}/`);
  if (inConfigDir && !syncObsidianConfig) return false;

  if (!inConfigDir && safePath.split("/").some((segment) => segment.startsWith("."))) {
    return false;
  }

  const patterns = [
    ...DEFAULT_EXCLUDED_PATTERNS,
    ...configExclusions(safeConfigDir),
    ...userPatterns,
  ];
  return !patterns.some((pattern) => globMatches(safePath, pattern));
}

export function assertSafeRemotePath(path: string): string {
  return normalizeSafePath(path);
}

export function globMatches(path: string, pattern: string): boolean {
  const trimmed = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!trimmed) return false;

  let expression = "^";
  for (let index = 0; index < trimmed.length; index++) {
    const character = trimmed[index];
    if (character === "*") {
      if (trimmed[index + 1] === "*") {
        index++;
        expression += ".*";
      } else {
        expression += "[^/]*";
      }
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  expression += "$";
  return new RegExp(expression).test(path);
}
