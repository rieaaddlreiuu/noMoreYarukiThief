import "server-only";
import { Octokit } from "@octokit/rest";
import { z } from "zod";
import { aiProvider, type ChangedFile, judgeCommits } from "./ai";
import { appOrigin, env } from "./config";
import { type Declaration, UserError } from "./domain";

export function githubClient() {
  return new Octokit({
    auth: process.env.GITHUB_API_TOKEN || undefined,
    userAgent: "nomoreyarukithief-mvp",
    request: { timeout: 8_000 },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
}

const headers = { "X-GitHub-Api-Version": "2026-03-10" };

export async function validateRepository(repository: string, branch?: string, client = githubClient()) {
  const [owner, repo] = repository.split("/");
  const signal = AbortSignal.timeout(15_000);
  try {
    const { data } = await client.repos.get({ owner, repo, headers, request: { signal } });
    if (data.private || data.visibility && data.visibility !== "public") throw new UserError("公開リポジトリのみ指定できます。");
    const selected = branch ?? data.default_branch;
    const checked = await client.repos.getBranch({ owner, repo, branch: selected, headers, request: { signal } });
    return { repository: data.full_name, branch: checked.data.name };
  } catch (error) {
    if (error instanceof UserError) throw error;
    if (error && typeof error === "object" && "status" in error && error.status === 404) {
      throw new UserError("公開リポジトリまたはブランチが見つかりません。少なくとも1件コミットのあるブランチを指定してください。");
    }
    throw new UserError("GitHubを確認できませんでした。宣言はまだ保存していません。時間をおいて再実行してください。");
  }
}

export type CommitCandidate = {
  sha: string;
  author: { id?: number } | null;
  parents?: { sha: string }[];
  commit: { committer: { date?: string } | null; message: string };
};

// Each diff costs one GitHub request, so only the newest candidates are read in full; the rest are judged by message.
const DIFF_COMMIT_LIMIT = 10;

export function matchesDeclaration(commit: CommitCandidate, declaration: Declaration) {
  if (commit.author?.id !== declaration.github_id) return false;
  const date = Date.parse(commit.commit.committer?.date ?? "");
  if (!Number.isFinite(date)) throw new Error("Missing commit timestamp");
  return date >= Date.parse(declaration.created_at) && date <= Date.parse(declaration.deadline);
}

async function commitFiles(client: Octokit, owner: string, repo: string, ref: string, signal: AbortSignal): Promise<ChangedFile[]> {
  const { data } = await client.repos.getCommit({ owner, repo, ref, headers, request: { signal } });
  return (data.files ?? []).map(({ filename, status, additions, deletions, patch }) => ({ filename, status, additions, deletions, patch }));
}

export async function findQualifyingCommit(declaration: Declaration, signal: AbortSignal, client = githubClient()): Promise<{ sha: string; aiReason?: string } | null> {
  const [owner, repo] = declaration.repository.split("/");
  const request = { signal };
  // A formerly public repository becoming private is a verification error, never a failure.
  const { data: repository } = await client.repos.get({ owner, repo, headers, request });
  if (repository.private || repository.visibility && repository.visibility !== "public") throw new Error("Repository is no longer public");
  // Check the named branch even if its history has since disappeared or changed.
  const { data: branch } = await client.repos.getBranch({ owner, repo, branch: declaration.branch, headers, request });
  const candidates: CommitCandidate[] = [];
  let scanComplete = false;
  for (let page = 1; page <= 20; page++) {
    const { data, headers: responseHeaders } = await client.repos.listCommits({
      owner, repo, sha: branch.commit.sha,
      // Expand server-side bounds by a second; the local inclusive comparison is authoritative.
      since: new Date(Date.parse(declaration.created_at) - 1000).toISOString(),
      until: new Date(Date.parse(declaration.deadline) + 1000).toISOString(),
      per_page: 100, page, headers, request,
    });
    candidates.push(...data.filter((commit) => matchesDeclaration(commit, declaration)));
    if (!responseHeaders.link?.includes('rel="next"')) { scanComplete = true; break; }
  }
  // Never report failure when pagination was incomplete.
  if (!scanComplete) throw new Error("Commit scan limit reached");

  if (candidates.length === 0) return null;
  if (!aiProvider()) return { sha: candidates[0].sha };

  // A merge commit's diff against its first parent can contain other people's work, so it is judged by message only.
  const isMerge = (commit: CommitCandidate) => (commit.parents?.length ?? 0) > 1;
  const diffTargets = new Set(candidates.filter((commit) => !isMerge(commit)).slice(0, DIFF_COMMIT_LIMIT));
  // A failed diff fetch throws like any other GitHub error, so the check is retried rather than judged on less evidence.
  const judged = await Promise.all(candidates.map(async (commit) => ({
    sha: commit.sha.slice(0, 7), message: commit.commit.message, merge: isMerge(commit),
    files: diffTargets.has(commit) ? await commitFiles(client, owner, repo, commit.sha, signal) : undefined,
  })));
  const verdict = await judgeCommits(declaration.content, judged, signal);
  if (!verdict) return null;
  return { sha: candidates[verdict.index].sha, aiReason: verdict.reason };
}

export async function exchangeGitHubCode(code: string, verifier: string) {
  const signal = AbortSignal.timeout(15_000);
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: env("GITHUB_CLIENT_ID"), client_secret: env("GITHUB_CLIENT_SECRET"),
      code, code_verifier: verifier, redirect_uri: `${appOrigin()}/api/github/callback` }),
    signal, cache: "no-store",
  });
  if (!response.ok) throw new Error("GitHub OAuth exchange failed");
  const token = z.object({ access_token: z.string().min(1) }).parse(await response.json());
  const identity = await fetch("https://api.github.com/user", {
    headers: { ...headers, Accept: "application/vnd.github+json", Authorization: `Bearer ${token.access_token}` },
    signal, cache: "no-store",
  });
  if (!identity.ok) throw new Error("GitHub identity check failed");
  // The user token is only used here. It is never stored in the DB or in a cookie.
  return z.object({ id: z.number().int().positive().safe(), login: z.string().min(1) }).parse(await identity.json());
}
