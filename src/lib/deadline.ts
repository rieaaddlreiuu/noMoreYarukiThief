const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const JST = 9 * 60 * MINUTE;
const EXAMPLES = "例: 23時 / 明日 9時 / 3時間後 / 10/5 21:00（日本時間）";

export class DeadlineInputError extends Error {
  constructor(reason: string) {
    super(`${reason}\n${EXAMPLES}`);
    this.name = "DeadlineInputError";
  }
}

function time(value: string): [number, number] {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value) ?? /^(\d{1,2})時(?:(\d{1,2})分)?$/.exec(value);
  if (!match) throw new DeadlineInputError("期限の書き方を読み取れませんでした。");
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (hour > 23 || minute > 59) throw new DeadlineInputError("期限の時刻が存在しません。");
  return [hour, minute];
}

// Validate before converting to UTC: Date normally rolls nonexistent dates into the next month.
function dateTime(year: number, month: number, day: number, hour: number, minute: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, 0, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day ||
      date.getUTCHours() !== hour || date.getUTCMinutes() !== minute) {
    throw new DeadlineInputError("期限の日付・時刻が存在しません。");
  }
  return date.getTime() - JST;
}

/** Interpret Japanese deadline input in JST and return a UTC ISO string. */
export function parseDeadline(value: string, now = new Date()): string {
  const input = value.replace(/[０-９：　]/g, (char) => char === "　" ? " " : String.fromCharCode(char.charCodeAt(0) - 0xfee0)).trim();
  const current = now.getTime();
  if (!Number.isFinite(current)) throw new DeadlineInputError("現在時刻が正しくありません。");
  const today = new Date(current + JST);
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth() + 1;
  const day = today.getUTCDate();
  let utc: number;
  const absolute = /^(\d{4})-(\d{2})-(\d{2}) +(\d{2}):(\d{2})$/.exec(input);
  const named = /^(今日|きょう|明日|あした|明後日|あさって)(?:\s*(?:の\s*)?(.+))?$/.exec(input);
  const relative = /^(\d+)(分|時間|日)後$/.exec(input);
  const calendar = /^(\d{1,2})\/(\d{1,2})(?: +(.+))?$/.exec(input);
  if (absolute) {
    utc = dateTime(Number(absolute[1]), Number(absolute[2]), Number(absolute[3]), Number(absolute[4]), Number(absolute[5]));
  } else if (named) {
    const offset = ["今日", "きょう"].includes(named[1]) ? 0 : ["明日", "あした"].includes(named[1]) ? 1 : 2;
    const [hour, minute] = named[2] ? time(named[2]) : [23, 59];
    utc = dateTime(year, month, day, hour, minute) + offset * DAY;
  } else if (relative) {
    const amount = Number(relative[1]);
    utc = relative[2] === "日" ? dateTime(year, month, day, 23, 59) + amount * DAY
      : current + amount * (relative[2] === "時間" ? 60 * MINUTE : MINUTE);
  } else if (calendar) {
    const [hour, minute] = calendar[3] ? time(calendar[3]) : [23, 59];
    utc = dateTime(year, Number(calendar[1]), Number(calendar[2]), hour, minute);
    if (utc < current) utc = dateTime(year + 1, Number(calendar[1]), Number(calendar[2]), hour, minute);
  } else {
    const [hour, minute] = time(input);
    utc = dateTime(year, month, day, hour, minute);
    if (utc < current) utc += DAY;
  }
  if (utc <= current) throw new DeadlineInputError("期限は現在より後に設定してください。");
  if (utc - current < 10 * MINUTE) throw new DeadlineInputError("期限は今から10分以上後に設定してください。");
  if (!Number.isFinite(utc) || utc - current > 30 * DAY) throw new DeadlineInputError("期限は今から30日以内に設定してください。");
  return new Date(utc).toISOString();
}
