import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStore } from "../src/lib/store";
import { declaration, discordId, guildId } from "./fixtures";

beforeEach(() => {
  vi.stubEnv("SUPABASE_URL", "https://database.example");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("receives a single declaration from PostgREST's table-valued RPC", async () => {
  const row = declaration();
  vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    // PostgREST returns table/composite results as an array unless singular JSON is requested.
    const singular = new Headers(init?.headers).get("accept") === "application/vnd.pgrst.object+json";
    return Response.json(singular ? row : [row]);
  }));
  const result = await createStore().createDeclaration({ interactionId: row.interaction_id, guildId, discordId,
    content: row.content, repository: row.repository, branch: row.branch, deadline: row.deadline });
  expect(result.id).toBe(row.id);
  expect(result.deadline).toBe(row.deadline);
});

it("handles empty SETOF jobs and scalar completion results separately", async () => {
  const row = declaration();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    return Response.json(url.endsWith("niki_finish_check") ? true : []);
  }));
  const store = createStore();
  expect(await store.claimCheck()).toBeNull();
  expect(await store.claimNotification()).toBeNull();
  expect(await store.finishCheck(row, null)).toBe(true);
});

it("does not expose database error details or the service key in user errors", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: "23505", message: "private details", details: "private data" }, { status: 409 })));
  const row = declaration();
  await expect(createStore().createDeclaration({ interactionId: row.interaction_id, guildId, discordId,
    content: row.content, repository: row.repository, branch: row.branch, deadline: row.deadline })).rejects.toThrow("進行中の宣言");
});
