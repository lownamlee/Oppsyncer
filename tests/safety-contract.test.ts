import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const clientSource = readFileSync("src/github/client.ts", "utf8");
const engineSource = readFileSync("src/sync/sync-engine.ts", "utf8");
const settingsSource = readFileSync("src/settings/settings.ts", "utf8");

test("the coordinated branch can only receive a non-forced update", () => {
  assert.match(clientSource, /force:\s*false/);
  assert.doesNotMatch(clientSource, /force:\s*true/);
});

test("both GitHub ref-race status codes enter recovery", () => {
  assert.match(engineSource, /\[409, 422\]\.includes\(error\.status\)/);
});

test("recovery is verified before a dirty local snapshot is materialized", () => {
  const recoveryStart = engineSource.indexOf("private async recoverAndAdopt(");
  const nextMethod = engineSource.indexOf("private async createSnapshotCommit(", recoveryStart);
  const recoveryMethod = engineSource.slice(recoveryStart, nextMethod);
  const verify = recoveryMethod.indexOf("createAndVerifyRecovery(");
  const materialize = recoveryMethod.indexOf("materializeRemote(");
  assert.ok(verify >= 0, "recovery creation call is missing");
  assert.ok(materialize > verify, "remote materialization precedes recovery verification");
});

test("local plugin credentials, volatile config, and Git metadata are fixed exclusions", () => {
  assert.match(engineSource, /settings\.syncObsidianConfig/);
  assert.match(readFileSync("src/sync/path-filter.ts", "utf8"), /plugins\/obsyncer\/data\.json\*/);
  assert.match(readFileSync("src/sync/path-filter.ts", "utf8"), /workspace\*\.json/);
  assert.match(settingsSource, /"\.git\/\*\*"/);
  assert.match(settingsSource, /"\.gitignore"/);
});

test("public repositories are rejected before synchronization", () => {
  assert.match(engineSource, /Refusing to synchronize notes with a public repository/);
});
