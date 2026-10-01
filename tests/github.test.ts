import { Octokit } from "@octokit/rest";
import { describe, expect, it, vi } from "vitest";
import { declaration } from "./fixtures";

const mocks = vi.hoisted(() => ({ judgeCommits: vi.fn() }));
vi.mock("../src/lib/ai", () => ({ judgeCommits: mocks.judgeCommits }));

const { findCommitWithUserToken, findQualifyingCommit, matchesDeclaration, validateRepository } = await import("../src/lib/github");
const { encryptToken } = await import("../src/lib/security");

function candidate(date: string, id = 1234, sha = "a".repeat(40), message = "ログイン画面を実装する") {
  return { sha, author: { id }, commit: { committer: { date }, message } };
}

it("matches the linked author ID and inclusive committer-time bounds", () => {
  const row = declaration();
  expect(matchesDeclaration(candidate(row.created_at), row)).toBe(true);
  expect(matchesDeclaration(candidate(row.deadline), row)).toBe(true);
  expect(matchesDeclaration(candidate("2026-09-26T09:59:59Z"), row)).toBe(false);
  expect(matchesDeclaration(candidate("2026-09-26T13:00:01Z"), row)).toBe(false);
  expect(matchesDeclaration(candidate(row.deadline, 9999), row)).toBe(false);
  expect(matchesDeclaration({ ...candidate(row.deadline), author: null }, row)).toBe(false);
});

function mockedClient(commitPages: { body: unknown; status?: number; next?: boolean }[], privateRepo = false) {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/commits?")) {
      const page = commitPages.shift()!;
      return Response.json(page.body, { status: page.status ?? 200, headers: page.next ? { link: '<https://api.github.com/repos/owner/repository/commits?page=2>; rel="next"' } : {} });
    }
    if (url.includes("/branches/")) return Response.json({ name: "main", commit: { sha: "branch-head" } });
    return Response.json({ private: privateRepo, full_name: "owner/repository", default_branch: "main" });
  });
  return { fetcher, client: new Octokit({ request: { fetch: fetcher }, log: { debug() {}, info() {}, warn() {}, error() {} } }) };
}

describe("public GitHub evaluation", () => {
  it("uses the default branch when omitted and rejects private repositories", async () => {
    expect(await validateRepository("owner/repository", undefined, mockedClient([]).client)).toEqual({ repository: "owner/repository", branch: "main" });
    await expect(validateRepository("owner/repository", undefined, mockedClient([], true).client)).rejects.toThrow("公開");
  });
  it("paginates and pins the selected branch head, without filtering by mutable login", async () => {
    const row = declaration();
    const { client, fetcher } = mockedClient([{ body: [candidate(row.deadline, 9999)], next: true }, { body: [candidate(row.deadline)] }]);
    expect(await findQualifyingCommit(row, AbortSignal.timeout(1000), client)).toEqual({ sha: "a".repeat(40) });
    expect(fetcher.mock.calls.map(([url]) => String(url)).filter((url) => url.includes("/commits?"))).toHaveLength(2);
    const query = new URL(String(fetcher.mock.calls.at(-1)![0])).searchParams;
    expect(query.get("sha")).toBe("branch-head");
    expect(query.has("author")).toBe(false);
  });
  it("returns no match only after a complete successful scan", async () => {
    const row = declaration();
    expect(await findQualifyingCommit(row, AbortSignal.timeout(1000), mockedClient([{ body: [] }]).client)).toBeNull();
    await expect(findQualifyingCommit(row, AbortSignal.timeout(1000), mockedClient([{ body: { message: "rate limited" }, status: 403 }]).client)).rejects.toThrow();
    await expect(findQualifyingCommit(row, AbortSignal.timeout(1000), mockedClient([], true).client)).rejects.toThrow();
    await expect(findQualifyingCommit(row, AbortSignal.timeout(2000), mockedClient(Array.from({ length: 20 }, () => ({ body: [], next: true }))).client)).rejects.toThrow("scan limit");
  });

  describe("AI judgement (GEMINI_API_KEY set)", () => {
    const withKey = <T>(fn: () => Promise<T>) => {
      process.env.GEMINI_API_KEY = "test-key";
      return fn().finally(() => { delete process.env.GEMINI_API_KEY; });
    };

    it("adopts the candidate the AI judge selects by index", async () => {
      const row = declaration();
      mocks.judgeCommits.mockResolvedValueOnce({ index: 1, reason: "宣言内容と一致" });
      const { client } = mockedClient([{ body: [candidate(row.deadline, 1234, "b".repeat(40)), candidate(row.deadline, 1234, "c".repeat(40))] }]);
      await expect(withKey(() => findQualifyingCommit(row, AbortSignal.timeout(1000), client)))
        .resolves.toEqual({ sha: "c".repeat(40), aiReason: "宣言内容と一致" });
    });

    it("treats a null verdict as unmet and reports the rejected candidates", async () => {
      const row = declaration();
      mocks.judgeCommits.mockResolvedValueOnce(null);
      const { client } = mockedClient([{ body: [candidate(row.deadline)] }]);
      await expect(withKey(() => findQualifyingCommit(row, AbortSignal.timeout(1000), client)))
        .resolves.toEqual({ sha: null, judged: ["a".repeat(40)] });
    });

    it("does not judge again when every candidate was already rejected", async () => {
      const row = declaration({ judged_shas: ["a".repeat(40)] });
      mocks.judgeCommits.mockClear();
      const { client } = mockedClient([{ body: [candidate(row.deadline)] }]);
      await expect(withKey(() => findQualifyingCommit(row, AbortSignal.timeout(1000), client))).resolves.toBeNull();
      expect(mocks.judgeCommits).not.toHaveBeenCalled();
    });

    it("propagates AI call failures instead of treating them as unmet", async () => {
      const row = declaration();
      mocks.judgeCommits.mockRejectedValueOnce(new Error("Gemini API HTTP 500"));
      const { client } = mockedClient([{ body: [candidate(row.deadline)] }]);
      await expect(withKey(() => findQualifyingCommit(row, AbortSignal.timeout(1000), client))).rejects.toThrow();
    });

    it("never calls the AI judge when there are no candidates", async () => {
      const row = declaration();
      const { client } = mockedClient([{ body: [] }]);
      await expect(withKey(() => findQualifyingCommit(row, AbortSignal.timeout(1000), client))).resolves.toBeNull();
      expect(mocks.judgeCommits).not.toHaveBeenCalled();
    });
  });
});

describe("per-user token checks", () => {
  const key = Buffer.alloc(32, 7);
  const row = declaration();
  const fakeStore = (stored: string | null) => ({ getGitHubToken: vi.fn(async () => stored), clearGitHubToken: vi.fn(async () => {}) });
  const setKey = () => vi.stubEnv("TOKEN_ENCRYPTION_KEY", key.toString("base64"));
  const unauthorized = () => Object.assign(new Error("Bad credentials"), { status: 401 });

  it("uses the operator client when no key or token is configured", async () => {
    const find = vi.fn(async () => ({ sha: "x" }));
    const store = fakeStore("v1.x.y.z");
    await findCommitWithUserToken(store, find)(row, AbortSignal.timeout(1000));
    expect(find).toHaveBeenCalledWith(row, expect.anything());
    expect(store.getGitHubToken).not.toHaveBeenCalled();
    setKey();
    try {
      await findCommitWithUserToken(fakeStore(null), find)(row, AbortSignal.timeout(1000));
      expect(find).toHaveBeenLastCalledWith(row, expect.anything());
    } finally { vi.unstubAllEnvs(); }
  });
  it("authenticates with the decrypted user token", async () => {
    setKey();
    try {
      const find = vi.fn().mockResolvedValue({ sha: "x" });
      await findCommitWithUserToken(fakeStore(encryptToken("gho_user", key)), find as never)(row, AbortSignal.timeout(1000));
      const client = find.mock.calls[0][2] as Octokit;
      expect(await client.auth()).toMatchObject({ type: "token", token: "gho_user" });
    } finally { vi.unstubAllEnvs(); }
  });
  it("drops a revoked token and retries with the operator token", async () => {
    setKey();
    try {
      const find = vi.fn(async (_d: unknown, _s: unknown, client?: unknown) => { if (client) throw unauthorized(); return { sha: "x" }; });
      const store = fakeStore(encryptToken("gho_user", key));
      expect(await findCommitWithUserToken(store, find as never)(row, AbortSignal.timeout(1000))).toEqual({ sha: "x" });
      expect(store.clearGitHubToken).toHaveBeenCalledWith(row.discord_id);
      expect(find).toHaveBeenCalledTimes(2);
    } finally { vi.unstubAllEnvs(); }
  });
  it("does not drop the token on other errors", async () => {
    setKey();
    try {
      const find = vi.fn(async () => { throw Object.assign(new Error("rate"), { status: 403 }); });
      const store = fakeStore(encryptToken("gho_user", key));
      await expect(findCommitWithUserToken(store, find as never)(row, AbortSignal.timeout(1000))).rejects.toThrow("rate");
      expect(store.clearGitHubToken).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });
});
