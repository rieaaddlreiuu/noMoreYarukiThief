import { describe, expect, it } from "vitest";
import { nikiLine, nikiLines, notificationMessage, type NikiScene } from "../src/lib/discord/messages";
import { declaration, discordId, notification } from "./fixtures";

const scenes = Object.keys(nikiLines) as NikiScene[];
// Picks the line at `index` out of `count` without relying on Math.random.
const pick = (index: number, count: number) => () => (index + 0.5) / count;
const all = (scene: NikiScene, words = { name: "みじょたく", content: "ログイン画面", deadline: "2026-09-28 22:00 JST" }) =>
  nikiLines[scene].map((_, i) => nikiLine(scene, words, pick(i, nikiLines[scene].length)));
const mention = `<@${discordId}>`;
const message = (kind: "declared" | "result" | "cancelled", status: "pending" | "succeeded" | "failed" | "cancelled", random?: () => number, content?: string) =>
  notificationMessage(notification({ kind }), declaration({ status, commit_sha: status === "succeeded" ? "a".repeat(40) : null, ...(content === undefined ? {} : { content }) }), random);
const posts = [["declared", "pending", "declared"], ["cancelled", "cancelled", "cancelled"], ["result", "succeeded", "succeeded"], ["result", "failed", "failed"]] as const;

const succeededLines = [
  `${mention}、やったじゃねぇか！「ログイン画面を実装する」、確かに見届けた。`,
  `コミット確認。${mention}、お前は口だけじゃなかったな。`,
  `期限内にやり切った${mention}に拍手。こういうのが一番かっこいいんだよ。`,
  `${mention}の草がまた伸びた。いい芝だ、この調子で育てていけ。`,
  `宣言して、やった。それだけのことが一番難しいんだ。よくやった、${mention}。`,
  `「ログイン画面を実装する」完了。${mention}、今日のメシはうまいぞ。`,
  `${mention}、宣言して、期限前に片付けた。仕事ができるやつの動きだな。`,
];

describe("Niki's lines", () => {
  it("has the agreed number of lines per scene", () => {
    expect(Object.fromEntries(scenes.map((scene) => [scene, nikiLines[scene].length]))).toEqual({ declared: 4, cancelled: 3, succeeded: 7, failed: 6, checkError: 1 });
  });
  it("posts one of the seven success lines", () => {
    for (let i = 0; i < 50; i++) expect(succeededLines).toContain(message("result", "succeeded").content);
  });
  it("selects a line from an injected random source", () => {
    expect(message("result", "succeeded", () => 0).content).toBe(succeededLines[0]);
    expect(message("result", "succeeded", () => 0.999).content).toBe(succeededLines[6]);
    expect(message("result", "succeeded", () => 1).content).toBe(succeededLines[6]);
    expect(succeededLines.map((_, i) => message("result", "succeeded", pick(i, 7)).content)).toEqual(succeededLines);
  });
  it("fills in the name, content and deadline without leaving placeholders", () => {
    for (const scene of scenes) {
      const lines = all(scene);
      for (const line of lines) {
        expect(line).not.toMatch(/[{}$]|undefined|null/);
        if (scene !== "checkError") expect(line).toContain("みじょたく");
      }
      if (["declared", "succeeded", "failed"].includes(scene)) expect(lines.some((line) => line.includes("「ログイン画面」"))).toBe(true);
    }
    expect(all("declared")[0]).toBe("みじょたくが宣言したぞ。「ログイン画面」、期限は2026-09-28 22:00 JST。言ったな？聞いたからな。");
    expect(all("failed")[0]).toBe("みじょたく……「ログイン画面」はどこ行った？俺のところには何も届いてねぇぞ。");
  });
  it("mentions the declarer exactly once", () => {
    for (const [kind, status, scene] of posts) {
      for (let i = 0; i < nikiLines[scene].length; i++) {
        const posted = message(kind, status, pick(i, nikiLines[scene].length));
        expect(posted.content!.split(mention)).toHaveLength(2);
        expect(posted.content!.match(/<@/g)).toHaveLength(1);
        expect(posted.allowed_mentions).toEqual({ parse: [], users: [discordId] });
      }
    }
  });
  it("stays within Discord's 2000 character limit for a 3000 character declaration", () => {
    for (const content of ["あ".repeat(3000), "*".repeat(3000), "@".repeat(3000)]) {
      for (const [kind, status, scene] of posts) {
        for (let i = 0; i < nikiLines[scene].length; i++) {
          expect(message(kind, status, pick(i, nikiLines[scene].length), content).content!.length).toBeLessThanOrEqual(2000);
        }
      }
      for (const scene of scenes) {
        for (const line of all(scene, { name: mention, content, deadline: "2026-09-28 22:00 JST" })) expect(line.length).toBeLessThanOrEqual(2000);
      }
    }
  });
  it("escapes formatting and mentions in the quoted content", () => {
    const posted = message("declared", "pending", () => 0, "@everyone **test**");
    expect(posted.content).not.toContain("@everyone");
    expect(posted.content).toContain("\\*\\*test\\*\\*");
  });
  it("never mixes lines from another scene", () => {
    for (const [kind, status, scene] of posts) {
      const own = all(scene, { name: mention, content: "ログイン画面を実装する", deadline: "2026-09-26 22:00 JST" });
      const others = scenes.filter((other) => other !== scene).flatMap((other) => all(other, { name: mention, content: "ログイン画面を実装する", deadline: "2026-09-26 22:00 JST" }));
      for (let i = 0; i < 50; i++) {
        const line = message(kind, status, i < own.length ? pick(i, own.length) : undefined).content!;
        expect(own).toContain(line);
        expect(others).not.toContain(line);
      }
    }
    for (let i = 0; i < 20; i++) {
      expect(nikiLine("checkError", { name: mention, content: "ログイン画面", deadline: "" })).toBe("GitHubの様子がおかしい。判定はちょっと待ってろ、逃がしはしねぇから。");
    }
  });
});
