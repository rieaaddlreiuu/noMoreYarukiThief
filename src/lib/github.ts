import "server-only";
import { Octokit } from "@octokit/rest";
import { z } from "zod";
import { judgeCommits } from "./ai";
import { appOrigin, env } from "./config";
import { type Declaration, UserError } from "./domain";
import type { CheckResult } from "./jobs";
import { decryptToken, parseTokenKey } from "./security";

// A user's own token (when linked) spreads rate limits per user; the operator token is the fallback.
export function githubClient(userToken?: string) {
  return new Octokit({
    auth: userToken || process.env.GITHUB_API_TOKEN || undefined,
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
  commit: { committer: { date?: string } | null; message: string };
};

export function matchesDeclaration(commit: CommitCandidate, declaration: Declaration) {
  if (commit.author?.id !== declaration.github_id) return false;
  const date = Date.parse(commit.commit.committer?.date ?? "");
  if (!Number.isFinite(date)) throw new Error("Missing commit timestamp");
  return date >= Date.parse(declaration.created_at) && date <= Date.parse(declaration.deadline);
}

export async function findQualifyingCommit(declaration: Declaration, signal: AbortSignal, client = githubClient()): Promise<CheckResult | null> {
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

  const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY);
  const alreadyJudged = candidates.filter((c) => declaration.judged_shas?.includes(c.sha)).length;
  console.log("[github] scan done", { declarationId: declaration.id, candidates: candidates.length, alreadyJudged, hasGeminiKey });
  if (candidates.length === 0) return null;
  if (!hasGeminiKey) {
    console.warn("[github] GEMINI_API_KEY missing: skipping AI judgement, adopting first candidate", { declarationId: declaration.id });
    return { sha: candidates[0].sha };
  }

  // Polling before the deadline sees the same candidates again; only judge when a new one has appeared.
  if (candidates.every((c) => declaration.judged_shas?.includes(c.sha))) {
    console.log("[github] all candidates already judged: skipping AI", { declarationId: declaration.id });
    return null;
  }
  const verdict = await judgeCommits(
    declaration.content,
    candidates.map((c) => ({ sha: c.sha.slice(0, 7), message: c.commit.message })),
    signal,
  );
  if (!verdict) {
    console.log("[github] AI rejected all candidates", { declarationId: declaration.id, candidates: candidates.length });
    return { sha: null, judged: candidates.map((c) => c.sha) };
  }
  console.log("[github] AI matched commit", { declarationId: declaration.id, sha: candidates[verdict.index].sha.slice(0, 7) });
  return { sha: candidates[verdict.index].sha, aiReason: verdict.reason };
}

type TokenStore = { getGitHubToken(discordId: string): Promise<string | null>; clearGitHubToken(discordId: string): Promise<void> };

// Checks a declaration with its owner's stored token. A revoked token (401) is dropped and the operator token takes over.
export function findCommitWithUserToken(store: TokenStore, find = findQualifyingCommit) {
  return async (declaration: Declaration, signal: AbortSignal) => {
    const key = parseTokenKey(process.env.TOKEN_ENCRYPTION_KEY);
    const stored = key ? await store.getGitHubToken(declaration.discord_id).catch((error) => {
      console.error("[github] getGitHubToken failed", { declarationId: declaration.id, name: error?.name });
      return null;
    }) : null;
    const token = key && stored ? decryptToken(stored, key) : null;
    console.log("[github] token route", {
      declarationId: declaration.id,
      hasKey: Boolean(key),
      hasStored: Boolean(stored),
      decrypted: Boolean(token),
      using: token ? "user" : "operator",
      hasOperatorToken: Boolean(process.env.GITHUB_API_TOKEN),
    });
    if (!token) return find(declaration, signal);
    try {
      return await find(declaration, signal, githubClient(token));
    } catch (error) {
      if (!(error && typeof error === "object" && "status" in error && error.status === 401)) throw error;
      console.warn("[github] user token rejected (401): clearing and falling back to operator token", { declarationId: declaration.id });
      await store.clearGitHubToken(declaration.discord_id).catch(() => {});
      return find(declaration, signal);
    }
  };
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
  // The caller encrypts the token before storing it; it must never reach a cookie or a log.
  const user = z.object({ id: z.number().int().positive().safe(), login: z.string().min(1) }).parse(await identity.json());
  return { ...user, token: token.access_token };
}
