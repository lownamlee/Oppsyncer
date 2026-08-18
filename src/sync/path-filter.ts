import { DEFAULT_EXCLUDED_PATTERNS } from "../settings/settings";

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

export function isIncludedPath(path: string, userPatterns: string[]): boolean {
  let safePath: string;
  try {
    safePath = normalizeSafePath(path);
  } catch {
    return false;
  }

  const patterns = [...DEFAULT_EXCLUDED_PATTERNS, ...userPatterns];
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
