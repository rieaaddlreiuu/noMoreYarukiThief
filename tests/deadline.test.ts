import { describe, expect, it } from "vitest";
import { DeadlineInputError, parseDeadline } from "../src/lib/deadline";
import { formatJst } from "../src/lib/domain";
import { nikiCommand } from "../src/lib/discord/commands";

const now = new Date("2026-10-01T11:00:00.000Z");

describe("deadline input acceptance cases", () => {
  it.each([
    ["2026-10-02 23:59", "2026-10-02 23:59", "2026-10-02T14:59:00.000Z"],
    ["23:00", "2026-10-01 23:00", "2026-10-01T14:00:00.000Z"],
    ["23時", "2026-10-01 23:00", "2026-10-01T14:00:00.000Z"],
    ["23時30分", "2026-10-01 23:30", "2026-10-01T14:30:00.000Z"],
    ["19:00", "2026-10-02 19:00", "2026-10-02T10:00:00.000Z"],
    ["今日", "2026-10-01 23:59", "2026-10-01T14:59:00.000Z"],
    ["明日", "2026-10-02 23:59", "2026-10-02T14:59:00.000Z"],
    ["明日 9時", "2026-10-02 09:00", "2026-10-02T00:00:00.000Z"],
    ["明日9:00", "2026-10-02 09:00", "2026-10-02T00:00:00.000Z"],
    ["あさって 18時", "2026-10-03 18:00", "2026-10-03T09:00:00.000Z"],
    ["3時間後", "2026-10-01 23:00", "2026-10-01T14:00:00.000Z"],
    ["30分後", "2026-10-01 20:30", "2026-10-01T11:30:00.000Z"],
    ["2日後", "2026-10-03 23:59", "2026-10-03T14:59:00.000Z"],
    ["10/5", "2026-10-05 23:59", "2026-10-05T14:59:00.000Z"],
    ["10/5 21:00", "2026-10-05 21:00", "2026-10-05T12:00:00.000Z"],
    ["２３：００", "2026-10-01 23:00", "2026-10-01T14:00:00.000Z"],
  ])("parses %s in JST and UTC", (input, jst, utc) => {
    const result = parseDeadline(input, now);
    expect(result).toBe(utc);
    expect(formatJst(result)).toBe(`${jst} JST`);
  });

  it.each([
    ["5分後", "10分以上"], ["40日後", "30日以内"], ["今日 19時", "現在より後"],
    ["9/30", "30日以内"], ["25時", "存在しません"], ["2026-02-30 23:00", "存在しません"],
    ["そのうち", "読み取れません"], ["", "読み取れません"],
  ])("rejects %s with a reason and at least three examples", (input, reason) => {
    expect(() => parseDeadline(input, now)).toThrow(DeadlineInputError);
    expect(() => parseDeadline(input, now)).toThrow(reason);
    try { parseDeadline(input, now); } catch (error) {
      expect((error as Error).message.split("例: ")[1].split(" / ").length).toBeGreaterThanOrEqual(3);
    }
  });

  it.each([
    ["明日", "2027-01-01 23:59", "2027-01-01T14:59:00.000Z"],
    ["1/2", "2027-01-02 23:59", "2027-01-02T14:59:00.000Z"],
    ["21:00", "2027-01-01 21:00", "2027-01-01T12:00:00.000Z"],
  ])("rolls %s into the next year", (input, jst, utc) => {
    const result = parseDeadline(input, new Date("2026-12-31T13:00:00.000Z"));
    expect(result).toBe(utc);
    expect(formatJst(result)).toBe(`${jst} JST`);
  });
});

describe("additional deadline boundaries", () => {
  it.each([
    ["きょう", "2026-10-01T14:59:00.000Z"], ["あした", "2026-10-02T14:59:00.000Z"],
    ["明後日", "2026-10-03T14:59:00.000Z"], ["今日の23時", "2026-10-01T14:00:00.000Z"],
    ["　明日　９時３０分　", "2026-10-02T00:30:00.000Z"], ["10/5 21時", "2026-10-05T12:00:00.000Z"],
    ["２０２６-１０-０２　２３：５９", "2026-10-02T14:59:00.000Z"],
    ["10分後", "2026-10-01T11:10:00.000Z"], ["720時間後", "2026-10-31T11:00:00.000Z"],
    ["2026-10-31 20:00", "2026-10-31T11:00:00.000Z"],
  ])("accepts %s", (input, utc) => expect(parseDeadline(input, now)).toBe(utc));

  it.each(["2/30", "4/31", "13/1", "0/5", "10/0", "23:60", "明日25時", "10/5 24時", "今日20:00", "20:00", "20:05", "2026-10-31 20:01", "43201分後", "-3時間後", "1.5時間後", "Infinity時間後", "9".repeat(400) + "日後", "　", "今日の", "3時間後です"])("rejects %s", (input) => {
    expect(() => parseDeadline(input, now)).toThrow(DeadlineInputError);
  });

  it("preserves seconds for relative durations and applies precise bounds", () => {
    const seconds = new Date("2026-10-01T11:00:00.001Z");
    expect(parseDeadline("10分後", seconds)).toBe("2026-10-01T11:10:00.001Z");
    expect(() => parseDeadline("20:10", seconds)).toThrow("10分以上");
    expect(() => parseDeadline("2026-10-31 20:00", new Date(now.getTime() - 1))).toThrow("30日以内");
    expect(now.toISOString()).toBe("2026-10-01T11:00:00.000Z");
  });

  it("validates leap days without normalizing them into March", () => {
    expect(parseDeadline("2/29", new Date("2028-02-01T11:00:00Z"))).toBe("2028-02-29T14:59:00.000Z");
    expect(() => parseDeadline("2/29", now)).toThrow("存在しません");
  });

  it("allows short input and keeps the command description within 100 characters", () => {
    const option = nikiCommand.options.find((command) => command.name === "declare")!.options!.find((option) => option.name === "deadline")!;
    expect(option.description.length).toBeLessThanOrEqual(100);
    expect(option).toMatchObject({ min_length: 1 });
  });
});
