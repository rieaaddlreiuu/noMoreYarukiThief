import { Octokit } from "@octokit/rest";
import { describe, expect, it, vi } from "vitest";
import { declaration } from "./fixtures";

const mocks = vi.hoisted(() => ({ judgeCommits: vi.fn() }));
vi.mock("../src/lib/ai", () => ({ judgeCommits: mocks.judgeCommits }));

const { findQualifyingCommit, matchesDeclaration, validateRepository } = await import("../src/lib/github");

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

const defaultDetail = (sha: string) => Response.json({ sha, files: [{ filename: "src/login.tsx", status: "added", additions: 1, deletions: 0, patch: `+// ${sha}` }] });

function mockedClient(commitPages: { body: unknown; status?: number; next?: boolean }[], privateRepo = false, detail = defaultDetail) {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/commits?")) {
      const page = commitPages.shift()!;
      return Response.json(page.body, { status: page.status ?? 200, headers: page.next ? { link: '<https://api.github.com/repos/owner/repository/commits?page=2>; rel="next"' } : {} });
    }
    const commit = /\/commits\/(\w+)$/.exec(url);
    if (commit) return detail(commit[1]);
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
    // Without GEMINI_API_KEY no diff is needed, so no per-commit requests are spent.
    expect(fetcher.mock.calls.filter(([url]) => /\/commits\/\w+$/.test(String(url)))).toHaveLength(0);
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

    it("treats a null verdict as unmet", async () => {
      const row = declaration();
      mocks.judgeCommits.mockResolvedValueOnce(null);
      const { client } = mockedClient([{ body: [candidate(row.deadline)] }]);
      await expect(withKey(() => findQualifyingCommit(row, AbortSignal.timeout(1000), client))).resolves.toBeNull();
    });

    it("propagates AI call failures instead of treating them as unmet", async () => {
      const row = declaration();
      mocks.judgeCommits.mockRejectedValueOnce(new Error("Gemini API HTTP 500"));
      const { client } = mockedClient([{ body: [candidate(row.deadline)] }]);
      await expect(withKey(() => findQualifyingCommit(row, AbortSignal.timeout(1000), client))).rejects.toThrow();
    });

    it("passes the diffs of the newest non-merge candidates to the AI judge", async () => {
      const row = declaration();
      mocks.judgeCommits.mockResolvedValueOnce(null);
      const sha = (i: number) => i.toString(16).padStart(40, "0");
      const merge = { ...candidate(row.deadline, 1234, sha(99), "Merge branch 'main'"), parents: [{ sha: "p1" }, { sha: "p2" }] };
      const commits = [merge, ...Array.from({ length: 12 }, (_, i) => candidate(row.deadline, 1234, sha(i), `commit ${i}`))];
      const { client, fetcher } = mockedClient([{ body: commits }]);
      await withKey(() => findQualifyingCommit(row, AbortSignal.timeout(1000), client));

      const fetched = fetcher.mock.calls.map(([url]) => /\/commits\/(\w+)$/.exec(String(url))?.[1]).filter(Boolean);
      expect(fetched).toEqual(Array.from({ length: 10 }, (_, i) => sha(i)));
      const [content, judged] = mocks.judgeCommits.mock.calls[0];
      expect(content).toBe(row.content);
      expect(judged).toHaveLength(13);
      expect(judged[0]).toEqual({ sha: sha(99).slice(0, 7), message: "Merge branch 'main'", merge: true, files: undefined });
      expect(judged[1]).toEqual({ sha: sha(0).slice(0, 7), message: "commit 0", merge: false,
        files: [{ filename: "src/login.tsx", status: "added", additions: 1, deletions: 0, patch: `+// ${sha(0)}` }] });
      expect(judged[11].files).toBeUndefined();
      expect(judged[12].files).toBeUndefined();
    });

    it("retries instead of judging when a diff cannot be fetched", async () => {
      const row = declaration();
      const { client } = mockedClient([{ body: [candidate(row.deadline)] }], false, () => Response.json({ message: "Server Error" }, { status: 502 }));
      await expect(withKey(() => findQualifyingCommit(row, AbortSignal.timeout(1000), client))).rejects.toThrow();
      expect(mocks.judgeCommits).not.toHaveBeenCalled();
    });

    it("never calls the AI judge when there are no candidates", async () => {
      const row = declaration();
      const { client } = mockedClient([{ body: [] }]);
      await expect(withKey(() => findQualifyingCommit(row, AbortSignal.timeout(1000), client))).resolves.toBeNull();
      expect(mocks.judgeCommits).not.toHaveBeenCalled();
    });
  });
});
