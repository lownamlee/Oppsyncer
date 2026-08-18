import assert from "node:assert/strict";
import test from "node:test";
import { decideSyncAction, SyncFacts } from "../src/sync/state-machine";

function decide(overrides: Partial<SyncFacts>) {
  return decideSyncAction({
    baselineSha: "A",
    remoteSha: "A",
    localEmpty: false,
    localEqualsBaseline: true,
    localEqualsRemote: true,
    ...overrides,
  });
}

test("an empty first run remains empty", () => {
  assert.equal(
    decide({ baselineSha: null, remoteSha: null, localEmpty: true }),
    "empty",
  );
});

test("a populated local vault initializes an empty remote", () => {
  assert.equal(
    decide({ baselineSha: null, remoteSha: null, localEmpty: false }),
    "initialize-remote",
  );
});

test("an empty local vault adopts a populated remote", () => {
  assert.equal(
    decide({ baselineSha: null, remoteSha: "B", localEmpty: true }),
    "adopt-remote",
  );
});

test("unknown populated sides stop instead of guessing", () => {
  assert.equal(
    decide({
      baselineSha: null,
      remoteSha: "B",
      localEmpty: false,
      localEqualsRemote: false,
    }),
    "bootstrap-blocked",
  );
});

test("local edit pushes only while the remote still equals the baseline", () => {
  assert.equal(
    decide({ localEqualsBaseline: false, localEqualsRemote: false }),
    "push-local",
  );
});

test("clean local state adopts an advanced remote", () => {
  assert.equal(
    decide({ remoteSha: "B", localEqualsBaseline: true, localEqualsRemote: false }),
    "adopt-remote",
  );
});

test("diverged dirty state requires recovery before remote adoption", () => {
  assert.equal(
    decide({ remoteSha: "B", localEqualsBaseline: false, localEqualsRemote: false }),
    "recover-and-adopt",
  );
});

test("already-materialized remote content records the new baseline", () => {
  assert.equal(
    decide({ remoteSha: "B", localEqualsBaseline: false, localEqualsRemote: true }),
    "record-remote-baseline",
  );
});

test("a disappeared established branch is never recreated automatically", () => {
  assert.equal(decide({ remoteSha: null }), "remote-missing");
});
