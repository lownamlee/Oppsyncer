import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const apiVersion = "2022-11-28";
const token = readGitHubToken();
const viewer = await github("/user");
const owner = viewer.login;
const suffix = `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
const repositoryName = `obsyncer-api-integration-${suffix}`;
const repositoryPath = `/repos/${owner}/${repositoryName}`;
let repositoryCreated = false;

try {
  const repository = await github("/user/repos", {
    method: "POST",
    body: {
      name: repositoryName,
      private: true,
      description: "Disposable ObSyncer API integration test",
    },
    expected: [201],
  });
  repositoryCreated = true;
  assert(repository.private, "GitHub did not create a private test repository");

  const baseline = await github(`${repositoryPath}/contents/note.md`, {
    method: "PUT",
    body: {
      message: "A baseline",
      content: base64(new TextEncoder().encode("A\n")),
    },
    expected: [201],
  });
  const shaA = baseline.commit.sha;

  const candidateB = await createCandidate(shaA, "B winner", [
    ["note.md", new TextEncoder().encode("B\n")],
    ["Media/手.png", Uint8Array.from([0, 1, 2, 127, 128, 255])],
    ["empty.md", new Uint8Array()],
  ]);
  const candidateC = await createCandidate(shaA, "C losing candidate", [
    ["note.md", new TextEncoder().encode("C\n")],
  ]);

  await github(`${repositoryPath}/git/refs/heads/main`, {
    method: "PATCH",
    body: { sha: candidateB.sha, force: false },
    expected: [200],
  });
  const rejected = await github(`${repositoryPath}/git/refs/heads/main`, {
    method: "PATCH",
    body: { sha: candidateC.sha, force: false },
    expected: [409, 422],
    returnResponse: true,
  });

  const recoveryBranch = "obsyncer-recovery/integration/C";
  await github(`${repositoryPath}/git/refs`, {
    method: "POST",
    body: { ref: `refs/heads/${recoveryBranch}`, sha: candidateC.sha },
    expected: [201],
  });

  const main = await github(`${repositoryPath}/git/ref/heads/main`);
  const recovery = await github(
    `${repositoryPath}/git/ref/heads/${recoveryBranch.split("/").map(encodeURIComponent).join("/")}`,
  );
  const winnerTree = await github(
    `${repositoryPath}/git/trees/${candidateB.tree.sha}?recursive=1`,
  );

  assert(main.object.sha === candidateB.sha, "main did not retain candidate B");
  assert(recovery.object.sha === candidateC.sha, "recovery did not retain candidate C");
  assert(winnerTree.truncated === false, "winner tree was unexpectedly truncated");
  assert(
    winnerTree.tree.filter((entry) => entry.type === "blob").length === 3,
    "winner tree did not preserve text, binary, and empty-file entries",
  );

  console.log(
    JSON.stringify(
      {
        repository: `${owner}/${repositoryName}`,
        private: repository.private,
        baseline: shaA.slice(0, 8),
        mainWinner: candidateB.sha.slice(0, 8),
        recoveryLoser: candidateC.sha.slice(0, 8),
        losingUpdateStatus: rejected.status,
        recoveryVerified: true,
        unicodeBinaryAndEmptyFilesVerified: true,
      },
      null,
      2,
    ),
  );
} finally {
  if (repositoryCreated) {
    await github(repositoryPath, { method: "DELETE", expected: [204] });
    console.log(`Deleted disposable repository: ${owner}/${repositoryName}`);
  }
}

async function createCandidate(parentSha, message, files) {
  const entries = [];
  for (const [path, bytes] of files) {
    const blob = await github(`${repositoryPath}/git/blobs`, {
      method: "POST",
      body: { content: base64(bytes), encoding: "base64" },
      expected: [201],
    });
    entries.push({ path, mode: "100644", type: "blob", sha: blob.sha });
  }
  const tree = await github(`${repositoryPath}/git/trees`, {
    method: "POST",
    body: { tree: entries },
    expected: [201],
  });
  const commit = await github(`${repositoryPath}/git/commits`, {
    method: "POST",
    body: { message, tree: tree.sha, parents: [parentSha] },
    expected: [201],
  });
  return { ...commit, tree };
}

async function github(
  path,
  { method = "GET", body, expected = [200], returnResponse = false } = {},
) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": apiVersion,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!expected.includes(response.status)) {
    throw new Error(
      `GitHub ${method} ${path} returned ${response.status}: ${data?.message ?? text}`,
    );
  }
  return returnResponse ? { status: response.status, data } : data;
}

function base64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readGitHubToken() {
  const options = { encoding: "utf8", windowsHide: true };
  if (process.platform === "win32") {
    return execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "gh auth token"], options).trim();
  }
  return execFileSync("gh", ["auth", "token"], options).trim();
}
