import { describe, expect, it } from "vitest";
import { previousWeek, weekFromStart, weeklyPayload, weeklyStats, weeklyText, type WeeklyMember, type WeeklySnapshot } from "../src/lib/weekly-summary";

const member = (id: string, succeeded: number, failed: number): WeeklyMember => ({ discord_id: id, github_login: `user-${id}`, succeeded, failed });
const snapshot = (members: WeeklyMember[], declaration_count = 1): WeeklySnapshot => ({ guild_id: "100000000000000001", channel_id: "300000000000000001", declaration_count, members });

describe("JST weekly boundaries", () => {
  it("covers Monday midnight through Sunday 23:59:59.999, with Monday 09:00 due time", () => {
    expect(previousWeek(new Date("2026-10-05T00:00:00Z"))).toEqual({
      weekStart: "2026-09-28", lastDay: "2026-10-04", start: "2026-09-27T15:00:00.000Z",
      end: "2026-10-04T15:00:00.000Z", dueAt: "2026-10-05T00:00:00.000Z",
    });
    expect(previousWeek(new Date("2026-10-04T14:59:59.999Z")).weekStart).toBe("2026-09-21");
    expect(previousWeek(new Date("2026-10-04T15:00:00Z")).weekStart).toBe("2026-09-28");
  });
  it.each([
    ["2027-01-04T00:00:00Z", "2026-12-28", "2027-01-03"],
    ["2028-03-06T00:00:00Z", "2028-02-28", "2028-03-05"],
    ["2026-11-02T00:00:00Z", "2026-10-26", "2026-11-01"],
  ])("handles year/month/leap boundaries: %s", (now, start, end) => {
    expect(previousWeek(new Date(now))).toMatchObject({ weekStart: start, lastDay: end });
  });
  it.each(["2026-09-29", "2026-02-30", "2026-9-28", "abc", "2026-09-28T00:00:00Z"])("rejects non-Monday or invalid week %s", (value) => {
    expect(() => weekFromStart(value)).toThrow();
  });
});

describe("weekly ranking and Niki text", () => {
  it("uses total finalized declarations for the team rate, not the mean of member rates", () => {
    const stats = weeklyStats([member("1", 1, 0), member("2", 1, 8), member("3", 0, 0)]);
    expect(stats).toMatchObject({ succeeded: 2, failed: 8, rate: 0.2 });
    expect(stats.mvp.map((m) => m.discord_id)).toEqual(["1"]);
    expect(stats.slacker.map((m) => m.discord_id)).toEqual(["2"]);
  });
  it("prioritizes success count, then exact rate, retaining all ties", () => {
    const stats = weeklyStats([member("1", 3, 2), member("2", 3, 1), member("3", 3, 1), member("4", 2, 0)]);
    expect(stats.mvp.map((m) => m.discord_id)).toEqual(["2", "3"]);
    expect(weeklyStats([member("1", 1, 999), member("2", 1, 1000)]).mvp.map((m) => m.discord_id)).toEqual(["1"]);
  });
  it("includes all members tied for most failures and has no zero-count winners", () => {
    expect(weeklyStats([member("1", 0, 2), member("2", 1, 2)]).slacker).toHaveLength(2);
    expect(weeklyStats([member("1", 0, 0)])).toMatchObject({ rate: null, mvp: [], slacker: [] });
    expect(weeklyStats([member("1", 0, 2)]).mvp).toEqual([]);
    expect(weeklyStats([member("1", 3, 0)]).slacker).toEqual([]);
  });
  it("uses one short sentence for a week with no declarations", () => {
    const text = weeklyText(snapshot([member("1", 0, 0)], 0), weekFromStart("2026-09-28"));
    expect(text).toContain("宣言ゼロ");
    expect(text).not.toContain("MVP");
    expect(text.split("\n")).toHaveLength(1);
  });
  it("does not call a pending/cancelled-only week a zero-declaration week", () => {
    const text = weeklyText(snapshot([member("1", 0, 0)]), weekFromStart("2026-09-28"));
    expect(text).toContain("達成率 対象なし");
    expect(text).toContain("MVP: 不在");
    expect(text).toContain("サボり王: 不在");
    expect(text).not.toContain("宣言ゼロ");
  });
  it("escapes user names, disables pings, and mentions each member only once", () => {
    const input = snapshot([{ ...member("200000000000000001", 1, 1), github_login: "@everyone *name*" }]);
    const { message, attachment } = weeklyPayload({ id: "id", week_start: "2026-09-28", snapshot: input });
    expect(attachment).toBeNull();
    expect(message.allowed_mentions).toEqual({ parse: [] });
    expect(message.content).not.toContain("@everyone");
    expect(message.content.match(/<@200000000000000001>/g)).toHaveLength(1);
    expect(message.content).toContain("今週取り返せよ");
  });
  it("keeps all members in one attachment instead of truncating large teams", () => {
    const input = snapshot(Array.from({ length: 200 }, (_, i) => member(String(200000000000000001n + BigInt(i)), 1, 0)));
    const { message, attachment } = weeklyPayload({ id: "id", week_start: "2026-09-28", snapshot: input });
    expect(message.content.length).toBeLessThanOrEqual(2000);
    expect(attachment).toContain(`<@${input.members.at(-1)!.discord_id}>`);
    expect(attachment).toContain("チーム全体: 達成 200");
  });
});
