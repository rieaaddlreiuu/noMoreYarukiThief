import { describe, expect, it } from "vitest";
import { declarationInput, parseDeadline, statistics } from "../src/lib/domain";
import { notificationMessage, statusMessage } from "../src/lib/discord/messages";
import { declaration, discordId, notification } from "./fixtures";

describe("Japanese deadlines", () => {
  const now = new Date("2026-09-26T00:00:00Z");
  it("converts JST input to UTC, including midnight", () => {
    expect(parseDeadline("2026-09-28 22:00", now)).toBe("2026-09-28T13:00:00.000Z");
    expect(parseDeadline("2026-09-28 00:00", now)).toBe("2026-09-27T15:00:00.000Z");
  });
  it.each(["2026-02-30 22:00", "2026-13-01 12:00", "2026-09-28 24:00", "2026-09-28 12:60", "2026-9-28 22:00", "2026-09-26 09:00", "2026-01-01 00:00"])("rejects invalid or past time: %s", (value) => {
    expect(() => parseDeadline(value, now)).toThrow();
  });
  it("rejects URL/path injection as a repository", () => {
    for (const repository of ["https://github.com/owner/repo", "owner/../repo", "owner/..", "owner/repo?x=1"]) {
      expect(declarationInput.safeParse({ content: "開発", repository, deadline: "x" }).success).toBe(false);
    }
  });
});

describe("team statistics", () => {
  const members = [{ discord_id: discordId, github_login: "octocat" }];
  it("excludes pending/errors/cancelled from the success-rate denominator", () => {
    const rows = [declaration({ status: "succeeded" }), declaration({ status: "failed" }), declaration(), declaration({ last_check_error: "API" }), declaration({ status: "cancelled" })];
    expect(statistics(members, rows)[0]).toMatchObject({ rate: 50, pending: 2, succeeded: 1, failed: 1 });
    expect(statistics(members, [declaration()])[0].rate).toBeNull();
  });
  it("counts distinct consecutive JST deadline dates and retains yesterday's streak", () => {
    const rows = ["2026-09-23T15:30:00Z", "2026-09-24T15:00:00Z", "2026-09-25T14:59:59Z"].map((deadline) => declaration({ status: "succeeded", deadline }));
    expect(statistics(members, rows, new Date("2026-09-26T00:00:00Z"))[0].streak).toBe(2);
    expect(statistics(members, rows, new Date("2026-09-26T15:00:00Z"))[0].streak).toBe(0);
    rows.push(declaration({ status: "succeeded", deadline: "2026-09-25T15:00:00Z" }));
    expect(statistics(members, rows, new Date("2026-09-26T00:00:00Z"))[0].streak).toBe(3);
  });
});

describe("Discord output", () => {
  it("only mentions the declarer even when content contains @everyone or a role", () => {
    const message = notificationMessage(notification(), declaration({ content: "@everyone <@&123456789012345678> **test**" }));
    expect(message.allowed_mentions).toEqual({ parse: [], users: [discordId] });
    expect(message.embeds![0].description).not.toContain("@everyone");
  });
  it("shows the AI judgement reason only for failed results, escaped", () => {
    const failed = declaration({ status: "failed", ai_reason: "無関係な *修正* @everyone" });
    const message = notificationMessage(notification(), failed);
    const field = message.embeds![0].fields!.find((f) => f.name === "AIの判定理由");
    expect(field?.value).toBe("無関係な \\*修正\\* @​everyone");

    const succeeded = declaration({ status: "succeeded", ai_reason: "一致", commit_sha: "a".repeat(40) });
    expect(notificationMessage(notification(), succeeded).embeds![0].fields!.some((f) => f.name === "AIの判定理由")).toBe(false);

    const declared = declaration({ ai_reason: null });
    expect(notificationMessage(notification({ kind: "declared" }), declared).embeds![0].fields!.some((f) => f.name === "AIの判定理由")).toBe(false);
  });
  it("keeps worst-case paginated messages within Discord embed limits", () => {
    const members = Array.from({ length: 11 }, (_, i) => ({ discord_id: String(200000000000000001n + BigInt(i)), github_login: "a".repeat(39) }));
    const rows = Array.from({ length: 15 }, (_, i) => declaration({ content: "*".repeat(500), repository: `owner/${"_".repeat(100)}`, branch: "_".repeat(255), status: i < 5 ? "pending" : "succeeded", commit_sha: i < 5 ? null : "a".repeat(40) }));
    const message = statusMessage(members, rows);
    const lengths = message.embeds!.map((embed) => (embed.title?.length ?? 0) + (embed.description?.length ?? 0) + (embed.footer?.text.length ?? 0));
    expect(lengths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(6000);
    expect(message.embeds!.every((embed) => (embed.description?.length ?? 0) <= 4096)).toBe(true);
    expect(statusMessage(members, rows, 3).content).toContain("3/3");
    expect(statusMessage(members, rows, 100).content).toContain("3/3");
  });
  it("limits status to one member when memberId is given", () => {
    const other = "200000000000000009";
    const rows = [declaration({ status: "succeeded" }), declaration({ discord_id: other, status: "failed" })];
    const message = statusMessage([{ discord_id: discordId, github_login: "octocat" }, { discord_id: other, github_login: "other" }], rows, 1, 0, new Date(), discordId);
    expect(message.content).toContain(`<@${discordId}>の状況`);
    expect(message.content).toContain("達成 1件 / 未達成 0件");
    expect(message.embeds!.map((e) => e.description).join()).not.toContain(other);
  });
});
