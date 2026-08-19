import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { addNoCacheQuery } from "../src/github/cache";

const clientSource = readFileSync("src/github/client.ts", "utf8");

test("GitHub GET cache busters preserve paths without query parameters", () => {
  assert.equal(
    addNoCacheQuery("/git/ref/heads/main", 1234, 5),
    "/git/ref/heads/main?obsyncer_no_cache=1234-5",
  );
});

test("GitHub GET cache busters preserve existing query parameters", () => {
  assert.equal(
    addNoCacheQuery("/git/trees/tree-sha?recursive=1", 1234, 6),
    "/git/trees/tree-sha?recursive=1&obsyncer_no_cache=1234-6",
  );
});

test("branch polling uses a stable conditional request", () => {
  assert.match(clientSource, /"If-None-Match"/);
  assert.match(clientSource, /response\.status === 304/);
  assert.match(clientSource, /stableGet:\s*true/);
});
