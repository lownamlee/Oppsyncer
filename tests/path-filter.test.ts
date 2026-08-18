import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSafeRemotePath,
  globMatches,
  isIncludedPath,
} from "../src/sync/path-filter";

test("fixed secret and application-state paths are excluded", () => {
  assert.equal(isIncludedPath(".obsidian/plugins/obsyncer/data.json", []), false);
  assert.equal(isIncludedPath(".git/config", []), false);
  assert.equal(isIncludedPath(".gitignore", []), false);
  assert.equal(isIncludedPath(".gitattributes", []), false);
  assert.equal(isIncludedPath(".gitmodules", []), false);
  assert.equal(isIncludedPath(".trash/old.md", []), false);
  assert.equal(isIncludedPath("notes/hello.md", []), true);
});

test("user glob exclusions support single and recursive stars", () => {
  assert.equal(isIncludedPath("Private/passwords.md", ["Private/**"]), false);
  assert.equal(isIncludedPath("Media/a.tmp", ["Media/*.tmp"]), false);
  assert.equal(isIncludedPath("Media/sub/a.tmp", ["Media/*.tmp"]), true);
  assert.equal(globMatches("a/b/c.md", "a/**"), true);
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
