import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GeminiApiError, judgeCommits } from "../src/lib/ai";

beforeEach(() => { vi.stubEnv("GEMINI_API_KEY", "test-key"); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function geminiResponse(text: string) {
  return Response.json({ candidates: [{ content: { parts: [{ text }] } }] });
}

it("returns the matched index and reason from a structured response", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => geminiResponse(JSON.stringify({ matchedIndex: 1, reason: "宣言内容と一致" }))));
  const result = await judgeCommits("ログイン画面を実装する", [
    { sha: "a1b2c3d", message: "typo修正" },
    { sha: "e4f5g6h", message: "ログイン画面を実装" },
  ], AbortSignal.timeout(1000));
  expect(result).toEqual({ index: 1, reason: "宣言内容と一致" });
});

it("returns null when the model finds no match", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => geminiResponse(JSON.stringify({ matchedIndex: null, reason: "無関係" }))));
  const result = await judgeCommits("ログイン画面を実装する", [{ sha: "a1b2c3d", message: "typo修正" }], AbortSignal.timeout(1000));
  expect(result).toBeNull();
});

it("treats an out-of-range index as no match rather than trusting it blindly", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => geminiResponse(JSON.stringify({ matchedIndex: 5, reason: "?" }))));
  const result = await judgeCommits("ログイン画面を実装する", [{ sha: "a1b2c3d", message: "typo修正" }], AbortSignal.timeout(1000));
  expect(result).toBeNull();
});

it("throws GeminiApiError on a non-2xx HTTP response", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
  await expect(judgeCommits("宣言", [{ sha: "a1b2c3d", message: "message" }], AbortSignal.timeout(1000)))
    .rejects.toThrow(GeminiApiError);
});

it("throws when the model output fails schema validation", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => geminiResponse(JSON.stringify({ matchedIndex: "not-a-number", reason: "x" }))));
  await expect(judgeCommits("宣言", [{ sha: "a1b2c3d", message: "message" }], AbortSignal.timeout(1000))).rejects.toThrow();
});

it("throws when the model output is not valid JSON", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => geminiResponse("not json")));
  await expect(judgeCommits("宣言", [{ sha: "a1b2c3d", message: "message" }], AbortSignal.timeout(1000))).rejects.toThrow();
});

it("throws when GEMINI_API_KEY is not configured", async () => {
  vi.unstubAllEnvs();
  await expect(judgeCommits("宣言", [{ sha: "a1b2c3d", message: "message" }], AbortSignal.timeout(1000))).rejects.toThrow("GEMINI_API_KEY");
});
