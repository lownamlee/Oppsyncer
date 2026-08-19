import assert from "node:assert/strict";
import test from "node:test";
import { DATA_SCHEMA_VERSION, normalizeData } from "../src/model";

test("schema-one state upgrades without trusting an incomplete local index", () => {
  const data = normalizeData({
    state: {
      schemaVersion: 1,
      deviceId: "device-id",
      baselineCommitSha: "commit",
      baselineTreeSha: "tree",
      baselineFiles: { "Note.md": "sha" },
      lastSuccessfulSyncAt: 1,
      lastRecoveryRef: null,
    },
  }, "desktop");

  assert.equal(data.state.schemaVersion, DATA_SCHEMA_VERSION);
  assert.equal(data.state.vaultId, null);
  assert.equal(data.state.vaultIdentityBlobSha, null);
  assert.deepEqual(data.state.localFiles, {});
  assert.deepEqual(data.state.baselineFiles, { "Note.md": "sha" });
});
