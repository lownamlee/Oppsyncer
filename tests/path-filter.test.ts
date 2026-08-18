import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSafeRemotePath,
  globMatches,
  isIncludedPath,
} from "../src/sync/path-filter";

test("Obsidian configuration is opt-in with fixed secret and volatile exclusions", () => {
  const configDir = ".obsidian";
  assert.equal(isIncludedPath(".obsidian/appearance.json", [], false, configDir), false);
  assert.equal(isIncludedPath(".obsidian/appearance.json", [], true, configDir), true);
  assert.equal(isIncludedPath(".obsidian/plugins/learnkit/data.json", [], true, configDir), true);
  assert.equal(isIncludedPath(".obsidian/plugins/learnkit/scheduling/flashcards.db", [], true, configDir), true);
  assert.equal(isIncludedPath(".obsidian/plugins/obsyncer/data.json", [], true, configDir), false);
  assert.equal(isIncludedPath(".obsidian/plugins/obsyncer/data.json.tmp", [], true, configDir), false);
  assert.equal(isIncludedPath(".obsidian/workspace-mobile.json", [], true, configDir), false);
  assert.equal(isIncludedPath(".obsidian/file-recovery.json", [], true, configDir), false);
  assert.equal(isIncludedPath(".obsidian/sync.json", [], true, configDir), false);
  assert.equal(isIncludedPath(".obsidian/cache/index", [], true, configDir), false);
  assert.equal(isIncludedPath(".obsidian/plugins/learnkit/scheduling/flashcards.db-wal", [], true, configDir), false);
  assert.equal(isIncludedPath(".git/config", [], false, configDir), false);
  assert.equal(isIncludedPath(".gitignore", [], false, configDir), false);
  assert.equal(isIncludedPath(".gitattributes", [], false, configDir), false);
  assert.equal(isIncludedPath(".gitmodules", [], false, configDir), false);
  assert.equal(isIncludedPath(".trash/old.md", [], false, configDir), false);
  assert.equal(isIncludedPath("Notes/.private/hidden.md", [], false, configDir), false);
  assert.equal(isIncludedPath("notes/hello.md", [], false, configDir), true);
});

test("user glob exclusions support single and recursive stars", () => {
  assert.equal(isIncludedPath("Private/passwords.md", ["Private/**"], false, ".obsidian"), false);
  assert.equal(isIncludedPath("Media/a.tmp", ["Media/*.tmp"], false, ".obsidian"), false);
  assert.equal(isIncludedPath("Media/sub/a.tmp", ["Media/*.tmp"], false, ".obsidian"), true);
  assert.equal(globMatches("a/b/c.md", "a/**"), true);
});

test("custom Obsidian configuration folders are honored", () => {
  assert.equal(isIncludedPath(".config/appearance.json", [], false, ".config"), false);
  assert.equal(isIncludedPath(".config/appearance.json", [], true, ".config"), true);
  assert.equal(isIncludedPath(".config/plugins/obsyncer/data.json", [], true, ".config"), false);
});

test("unsafe remote paths are rejected", () => {
  for (const path of [
    "../outside.md",
    "/absolute.md",
    "C:/drive.md",
    "a//b.md",
    "Folder\\note.md",
    "./note.md",
    "CON.txt",
    "trailing-dot.",
    "question?.md",
  ]) {
    assert.throws(() => assertSafeRemotePath(path));
  }
  assert.equal(assertSafeRemotePath("Folder/note.md"), "Folder/note.md");
});
