import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ create: vi.fn(), preview: vi.fn(), run: vi.fn(), deliver: vi.fn() }));
vi.mock("../src/lib/weekly-store", () => ({ createWeeklyStore: mocks.create }));
vi.mock("../src/lib/weekly-jobs", () => ({ runWeeklyJobs: mocks.run }));
vi.mock("../src/lib/discord/weekly-client", () => ({ deliverWeekly: mocks.deliver }));
import { POST } from "../src/app/api/jobs/weekly/route";

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "s".repeat(32));
  mocks.create.mockReturnValue({ preview: mocks.preview });
  mocks.preview.mockResolvedValue([{ guild_id: "100000000000000001", channel_id: "300000000000000001", declaration_count: 0, members: [] }]);
  mocks.run.mockResolvedValue({ prepared: 1, sent: 1, retry: 0, stale: 0 });
});
afterEach(() => vi.unstubAllEnvs());
const request = (body = "{}", auth = `Bearer ${"s".repeat(32)}`) => new Request("https://niki.example/api/jobs/weekly", {
  method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body,
});

it("rejects missing/wrong secrets before accessing data", async () => {
  expect((await POST(request("{}", ""))).status).toBe(401);
  expect((await POST(request("{}", "Bearer wrong"))).status).toBe(401);
  expect(mocks.create).not.toHaveBeenCalled();
  vi.stubEnv("CRON_SECRET", "short");
  expect((await POST(request())).status).toBe(503);
});
it("defaults to a read-only preview, with full text and no delivery or writes", async () => {
  const response = await POST(request('{"weekStart":"2026-09-28"}'));
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json();
  expect(body.dryRun).toBe(true);
  expect(body.reports[0].content).toContain("宣言ゼロ");
  expect(mocks.preview).toHaveBeenCalledWith("2026-09-28", undefined);
  expect(mocks.run).not.toHaveBeenCalled();
  expect(mocks.deliver).not.toHaveBeenCalled();
});
it("requires explicit false to send and supports only the automatic week in live mode", async () => {
  const response = await POST(request('{"dryRun":false}'));
  expect(await response.json()).toMatchObject({ dryRun: false, sent: 1 });
  expect(mocks.run).toHaveBeenCalledOnce();
});
it.each(['{"dryRun":"false"}', '{"weekStart":"2026-09-29"}', '{"weekStart":"2026-02-30"}', '{"dryRun":false,"weekStart":"2026-09-28"}', '{"dryRun":false,"after":"100000000000000001"}', '{"unknown":1}', 'not json'])("rejects malformed or unsafe options: %s", async (body) => {
  expect((await POST(request(body))).status).toBe(400);
  expect(mocks.create).not.toHaveBeenCalled();
});
it("returns a cursor for previews exceeding one page", async () => {
  mocks.preview.mockResolvedValue(Array.from({ length: 100 }, (_, i) => ({ guild_id: String(100000000000000001n + BigInt(i)), channel_id: "300000000000000001", declaration_count: 0, members: [] })));
  const result = await (await POST(request())).json();
  expect(result.nextCursor).toBe("100000000000000100");
  await POST(request('{"after":"100000000000000100"}'));
  expect(mocks.preview).toHaveBeenLastCalledWith(expect.any(String), "100000000000000100");
});
it("hides sensitive errors", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.preview.mockRejectedValueOnce(new Error("secret"));
  const response = await POST(request());
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("secret");
});
