import assert from "node:assert/strict";
import test from "node:test";
import type { Vault } from "obsidian";
import { ObSyncerSettings } from "../src/settings/settings";
import {
  hasCompleteLocalIndex,
  scanLocalVault,
} from "../src/sync/local-snapshot";

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
    getFiles: () => [{
      path: "Note.md",
      stat: { size: contents["Note.md"].length, mtime: 1, ctime: 1 },
    }],
    adapter: {
      exists: async (path: string) => path === ".obsidian",
      list: async (path: string) => folders[path],
      stat: async (path: string) => contents[path]
        ? {
          type: "file" as const,
          size: new TextEncoder().encode(contents[path]).byteLength,
          mtime: 1,
          ctime: 1,
        }
        : null,
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

test("unchanged size and mtime reuse the cached Git blob SHA", async () => {
  let reads = 0;
  const bytes = new TextEncoder().encode("cached note");
  const vault = {
    configDir: ".obsidian",
    getFiles: () => [{
      path: "Cached.md",
      stat: { size: bytes.byteLength, mtime: 10, ctime: 1 },
    }],
    adapter: {
      stat: async () => ({
        type: "file" as const,
        size: bytes.byteLength,
        mtime: 10,
        ctime: 1,
      }),
      readBinary: async () => {
        reads++;
        return bytes.buffer;
      },
    },
  } as unknown as Vault;

  const first = await scanLocalVault(vault, baseSettings);
  assert.equal(reads, 1);
  const second = await scanLocalVault(vault, baseSettings, {
    cachedFiles: first.files,
  });
  assert.equal(reads, 1);
  assert.deepEqual(second, first);
});

test("incremental scanning is enabled only for a complete baseline index", () => {
  const indexed = {
    "Note.md": {
      path: "Note.md",
      sha: "abc",
      size: 4,
      mtime: 1,
    },
  };
  assert.equal(hasCompleteLocalIndex(indexed, { "Note.md": "abc" }), true);
  assert.equal(hasCompleteLocalIndex(indexed, { "Note.md": "different" }), false);
  assert.equal(
    hasCompleteLocalIndex(indexed, { "Note.md": "abc", "Other.md": "def" }),
    false,
  );
});
