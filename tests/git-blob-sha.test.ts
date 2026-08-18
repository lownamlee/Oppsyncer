import assert from "node:assert/strict";
import test from "node:test";
import { gitBlobSha } from "../src/hash";

test("Git blob hashing matches Git's object format", async () => {
  const sha = await gitBlobSha(new TextEncoder().encode("hello\n"));
  assert.equal(sha, "ce013625030ba8dba906f756967f9e9ca394464a");
});
