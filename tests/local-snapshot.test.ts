import assert from "node:assert/strict";
import test from "node:test";
import type { Vault } from "obsidian";
import { ObSyncerSettings } from "../src/settings/settings";
import { scanLocalVault } from "../src/sync/local-snapshot";

const baseSettings: ObSyncerSettings = {
  githubToken: "test-only",
  githubOwner: "owner",
  githubRepo: "repo",
  githubBranch: "main",
  deviceName: "test",
  autoSync: true,
  syncObsidianConfig: false,
  editDebounceSeconds: 3,
  remotePollSeconds: 15,
  excludedPatterns: [],
  showStatusBar: true,
};

function createVault(): Vault {
  const contents: Record<string, string> = {
    "Note.md": "note",
    ".obsidian/appearance.json": "appearance",
    ".obsidian/workspace.json": "workspace",
    ".obsidian/plugins/learnkit/data.json": "learnkit",
    ".obsidian/plugins/obsyncer/data.json": "secret",
    ".obsidian/plugins/obsyncer/main.js": "plugin",
  };
  const folders: Record<string, { files: string[]; folders: string[] }> = {
    ".obsidian": {
      files: [".obsidian/appearance.json", ".obsidian/workspace.json"],
      folders: [".obsidian/plugins"],
    },
    ".obsidian/plugins": {
      files: [],
      folders: [".obsidian/plugins/learnkit", ".obsidian/plugins/obsyncer"],
    },
    ".obsidian/plugins/learnkit": {
      files: [".obsidian/plugins/learnkit/data.json"],
      folders: [],
    },
    ".obsidian/plugins/obsyncer": {
      files: [
        ".obsidian/plugins/obsyncer/data.json",
        ".obsidian/plugins/obsyncer/main.js",
      ],
      folders: [],
    },
  };

  return {
    configDir: ".obsidian",
    getFiles: () => [{ path: "Note.md" }],
    adapter: {
      exists: async (path: string) => path === ".obsidian",
      list: async (path: string) => folders[path],
      readBinary: async (path: string) =>
        new TextEncoder().encode(contents[path]).buffer,
    },
  } as unknown as Vault;
}

test("hidden Obsidian files are scanned only when enabled", async () => {
  const disabled = await scanLocalVault(createVault(), baseSettings);
  assert.deepEqual(Object.keys(disabled.files), ["Note.md"]);

  const enabled = await scanLocalVault(createVault(), {
    ...baseSettings,
    syncObsidianConfig: true,
  });
  assert.deepEqual(Object.keys(enabled.files).sort(), [
    ".obsidian/appearance.json",
    ".obsidian/plugins/learnkit/data.json",
    ".obsidian/plugins/obsyncer/main.js",
    "Note.md",
  ]);
});
