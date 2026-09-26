import { Octokit } from "@octokit/rest";
import { describe, expect, it, vi } from "vitest";
import { findQualifyingCommit, matchesDeclaration, validateRepository } from "../src/lib/github";
import { declaration } from "./fixtures";

function candidate(date: string, id = 1234, sha = "a".repeat(40)) {
  return { sha, author: { id }, commit: { committer: { date } } };
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
    expect(await findQualifyingCommit(row, AbortSignal.timeout(1000), client)).toBe("a".repeat(40));
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
});
