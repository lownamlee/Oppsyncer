import { requestUrl, RequestUrlResponse } from "obsidian";
import { ObSyncerSettings } from "../settings/settings";
import { RemoteFileState, RemoteSnapshot } from "../model";
import { base64ToBytes, bytesToBase64, sleep } from "../utils";
import { addNoCacheQuery } from "./cache";

const API_VERSION = "2022-11-28";
const MAX_ATTEMPTS = 3;
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);

export interface RepositoryInfo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
}

export interface GitTreeEntry {
  path: string;
  mode: string;
  type: "blob";
  sha: string | null;
}

export interface CommitFileAddition {
  path: string;
  contents: Uint8Array;
}

export interface AtomicCommitResult {
  commitSha: string;
  treeSha: string;
}

interface RequestOptions {
  stableGet?: boolean;
  headers?: Record<string, string>;
}

export class GitHubApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export default class GitHubClient {
  private requestSequence = 0;
  private branchEtag: string | null = null;
  private branchSha: string | null = null;

  constructor(private readonly settings: ObSyncerSettings) {}

  async getRepository(): Promise<RepositoryInfo> {
    const response = await this.request("GET", "");
    this.assertSuccess(response, "read repository");
    const data = response.json as {
      full_name: string;
      private: boolean;
      default_branch: string;
    };
    return {
      fullName: data.full_name,
      private: data.private,
      defaultBranch: data.default_branch,
    };
  }

  async getBranchHead(): Promise<string | null> {
    const ref = `heads/${this.settings.githubBranch}`;
    const headers = this.branchEtag
      ? { "If-None-Match": this.branchEtag }
      : undefined;
    const response = await this.request(
      "GET",
      `/git/ref/${encodeRef(ref)}`,
      undefined,
      { stableGet: true, headers },
    );
    if (response.status === 304) return this.branchSha;
    if (response.status === 404 || response.status === 409) {
      this.branchEtag = null;
      this.branchSha = null;
      return null;
    }
    this.assertSuccess(response, `read branch ${this.settings.githubBranch}`);
    this.branchEtag = getResponseHeader(response, "etag");
    this.branchSha = (response.json as { object: { sha: string } }).object.sha;
    return this.branchSha;
  }

  async getRemoteSnapshot(commitSha: string): Promise<RemoteSnapshot> {
    const commitResponse = await this.request(
      "GET",
      `/git/commits/${encodeURIComponent(commitSha)}`,
    );
    this.assertSuccess(commitResponse, `read commit ${commitSha.slice(0, 8)}`);
    const commit = commitResponse.json as { sha: string; tree: { sha: string } };

    const treeResponse = await this.request(
      "GET",
      `/git/trees/${encodeURIComponent(commit.tree.sha)}?recursive=1`,
    );
    this.assertSuccess(treeResponse, `read tree ${commit.tree.sha.slice(0, 8)}`);
    const tree = treeResponse.json as {
      sha: string;
      truncated: boolean;
      tree: Array<{
        path: string;
        mode: string;
        type: string;
        sha: string;
        size?: number;
      }>;
    };
    if (tree.truncated) {
      throw new Error("The GitHub tree response was truncated; refusing an incomplete sync.");
    }

    const files: Record<string, RemoteFileState> = {};
    for (const entry of tree.tree) {
      if (entry.type === "tree") continue;
      if (entry.type !== "blob") {
        throw new Error(`Unsupported Git object at ${entry.path}: ${entry.type}`);
      }
      files[entry.path] = {
        path: entry.path,
        mode: entry.mode,
        type: "blob",
        sha: entry.sha,
        size: entry.size ?? 0,
      };
    }

    return {
      commitSha: commit.sha,
      treeSha: tree.sha,
      files,
    };
  }

  async getBlobBytes(sha: string): Promise<Uint8Array> {
    const response = await this.request(
      "GET",
      `/git/blobs/${encodeURIComponent(sha)}`,
    );
    this.assertSuccess(response, `download blob ${sha.slice(0, 8)}`);
    const blob = response.json as { content: string; encoding: string };
    if (blob.encoding !== "base64") {
      throw new Error(`Unsupported GitHub blob encoding: ${blob.encoding}`);
    }
    return base64ToBytes(blob.content);
  }

  async createBlob(bytes: Uint8Array): Promise<string> {
    const response = await this.request("POST", "/git/blobs", {
      content: bytesToBase64(bytes),
      encoding: "base64",
    });
    this.assertSuccess(response, "create blob");
    return (response.json as { sha: string }).sha;
  }

  async createTree(entries: GitTreeEntry[], baseTreeSha?: string): Promise<string> {
    const response = await this.request("POST", "/git/trees", {
      ...(baseTreeSha ? { base_tree: baseTreeSha } : {}),
      tree: entries,
    });
    this.assertSuccess(response, "create tree");
    return (response.json as { sha: string }).sha;
  }

  async createCommit(
    treeSha: string,
    parentSha: string | null,
    message: string,
  ): Promise<string> {
    const response = await this.request("POST", "/git/commits", {
      message,
      tree: treeSha,
      parents: parentSha ? [parentSha] : [],
    });
    this.assertSuccess(response, "create commit");
    return (response.json as { sha: string }).sha;
  }

  async createCommitOnBranch(
    expectedHeadSha: string,
    message: string,
    additions: CommitFileAddition[],
    deletions: string[],
  ): Promise<AtomicCommitResult> {
    const query = `
      mutation CreateOppsyncerCommit($input: CreateCommitOnBranchInput!) {
        createCommitOnBranch(input: $input) {
          commit {
            oid
            tree { oid }
          }
        }
      }
    `;
    const fileChanges = {
      ...(additions.length > 0
        ? {
          additions: additions.map((file) => ({
            path: file.path,
            contents: bytesToBase64(file.contents),
          })),
        }
        : {}),
      ...(deletions.length > 0
        ? { deletions: deletions.map((path) => ({ path })) }
        : {}),
    };
    const response = await this.requestGraphql({
      query,
      variables: {
        input: {
          branch: {
            repositoryNameWithOwner: `${this.settings.githubOwner}/${this.settings.githubRepo}`,
            branchName: this.settings.githubBranch,
          },
          expectedHeadOid: expectedHeadSha,
          message: { headline: message },
          fileChanges,
        },
      },
    });
    this.assertSuccess(response, "create atomic commit");
    const payload = response.json as {
      data?: {
        createCommitOnBranch?: {
          commit: { oid: string; tree: { oid: string } };
        } | null;
      };
      errors?: Array<{ type?: string; message?: string }>;
    };
    if (payload.errors?.length) {
      const messageText = payload.errors
        .map((error) => error.message)
        .filter(Boolean)
        .join("; ");
      if (payload.errors.some((error) => error.type === "STALE_DATA")) {
        throw new GitHubApiError(
          422,
          messageText || "The remote branch advanced before the commit was accepted.",
        );
      }
      throw new GitHubApiError(
        400,
        `Unable to create atomic commit${messageText ? `: ${messageText}` : ""}`,
      );
    }
    const commit = payload.data?.createCommitOnBranch?.commit;
    if (!commit?.oid || !commit.tree?.oid) {
      throw new Error("GitHub did not return the created commit and tree identifiers.");
    }
    this.branchEtag = null;
    this.branchSha = commit.oid;
    return { commitSha: commit.oid, treeSha: commit.tree.oid };
  }

  async createInitialFile(
    path: string,
    bytes: Uint8Array,
    message: string,
  ): Promise<string> {
    const response = await this.request(
      "PUT",
      `/contents/${encodePath(path)}`,
      { message, content: bytesToBase64(bytes) },
    );
    this.assertSuccess(response, "initialize empty repository");
    this.branchEtag = null;
    this.branchSha = null;
    return (response.json as { commit: { sha: string } }).commit.sha;
  }

  async updateMainWithoutForce(commitSha: string): Promise<void> {
    const ref = `heads/${this.settings.githubBranch}`;
    const response = await this.request("PATCH", `/git/refs/${encodeRef(ref)}`, {
      sha: commitSha,
      force: false,
    });
    this.assertSuccess(response, "advance main branch");
    this.branchEtag = null;
    this.branchSha = commitSha;
  }

  async createReference(branchName: string, commitSha: string): Promise<void> {
    const response = await this.request("POST", "/git/refs", {
      ref: `refs/heads/${branchName}`,
      sha: commitSha,
    });
    this.assertSuccess(response, `create recovery branch ${branchName}`);
    if (branchName === this.settings.githubBranch) {
      this.branchEtag = null;
      this.branchSha = commitSha;
    }
  }

  async getReference(branchName: string): Promise<string | null> {
    const response = await this.request(
      "GET",
      `/git/ref/${encodeRef(`heads/${branchName}`)}`,
    );
    if (response.status === 404) return null;
    this.assertSuccess(response, `verify recovery branch ${branchName}`);
    return (response.json as { object: { sha: string } }).object.sha;
  }

  private async request(
    method: string,
    path: string,
    body?: object,
    options: RequestOptions = {},
  ): Promise<RequestUrlResponse> {
    const requestPath =
      method === "GET" && !options.stableGet
        ? addNoCacheQuery(path, Date.now(), ++this.requestSequence)
        : path;
    const url = `https://api.github.com/repos/${encodeURIComponent(
      this.settings.githubOwner,
    )}/${encodeURIComponent(this.settings.githubRepo)}${requestPath}`;

    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const response = await requestUrl({
          url,
          method,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${this.settings.githubToken}`,
            "X-GitHub-Api-Version": API_VERSION,
            "Content-Type": "application/json",
            "Cache-Control": "no-cache, max-age=0",
            Pragma: "no-cache",
            ...(options.headers ?? {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          throw: false,
        });
        if (!TRANSIENT_STATUSES.has(response.status) || attempt === MAX_ATTEMPTS - 1) {
          return response;
        }
      } catch (error) {
        lastError = error;
        if (attempt === MAX_ATTEMPTS - 1) throw error;
      }
      await sleep(500 * 2 ** attempt);
    }
    throw lastError instanceof Error ? lastError : new Error("GitHub request failed");
  }

  private async requestGraphql(body: object): Promise<RequestUrlResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const response = await requestUrl({
          url: "https://api.github.com/graphql",
          method: "POST",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${this.settings.githubToken}`,
            "Content-Type": "application/json",
            "Cache-Control": "no-cache, max-age=0",
            Pragma: "no-cache",
          },
          body: JSON.stringify(body),
          throw: false,
        });
        if (!TRANSIENT_STATUSES.has(response.status) || attempt === MAX_ATTEMPTS - 1) {
          return response;
        }
      } catch (error) {
        lastError = error;
        if (attempt === MAX_ATTEMPTS - 1) throw error;
      }
      await sleep(500 * 2 ** attempt);
    }
    throw lastError instanceof Error ? lastError : new Error("GitHub request failed");
  }

  private assertSuccess(response: RequestUrlResponse, operation: string): void {
    if (response.status >= 200 && response.status < 300) return;
    const message = (response.json as { message?: string } | null)?.message;
    throw new GitHubApiError(
      response.status,
      `Unable to ${operation} (GitHub ${response.status}${message ? `: ${message}` : ""})`,
    );
  }
}

function getResponseHeader(
  response: RequestUrlResponse,
  name: string,
): string | null {
  const match = Object.entries(response.headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return match?.[1] ?? null;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function encodeRef(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}
