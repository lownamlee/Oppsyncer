export interface ObSyncerSettings {
  githubToken: string;
  githubOwner: string;
  githubRepo: string;
  githubBranch: string;
  deviceName: string;
  autoSync: boolean;
  syncObsidianConfig: boolean;
  editDebounceSeconds: number;
  remotePollSeconds: number;
  excludedPatterns: string[];
  showStatusBar: boolean;
}

export const DEFAULT_EXCLUDED_PATTERNS = [
  ".git/**",
  "**/.git/**",
  ".gitignore",
  ".gitattributes",
  ".gitmodules",
  ".trash/**",
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
  "**/*.db-wal",
  "**/*.db-shm",
  "**/*.db-journal",
  "conflict-files-obsidian-git.md",
] as const;

export const DEFAULT_SETTINGS: ObSyncerSettings = {
  githubToken: "",
  githubOwner: "",
  githubRepo: "",
  githubBranch: "main",
  deviceName: "",
  autoSync: true,
  syncObsidianConfig: false,
  editDebounceSeconds: 3,
  remotePollSeconds: 15,
  excludedPatterns: [],
  showStatusBar: true,
};

export function settingsAreConfigured(settings: ObSyncerSettings): boolean {
  return Boolean(
    settings.githubToken.trim() &&
      settings.githubOwner.trim() &&
      settings.githubRepo.trim() &&
      settings.githubBranch.trim(),
  );
}
