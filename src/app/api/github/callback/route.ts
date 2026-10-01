import { NextRequest } from "next/server";
import { createDiscordClient } from "@/lib/discord/client";
import { UserError } from "@/lib/domain";
import { exchangeGitHubCode } from "@/lib/github";
import { oauthCookieName, oauthResponse, tokenPattern } from "@/lib/oauth-response";
import { encryptToken, hashToken, parseTokenKey, safeError } from "@/lib/security";
import { createStore } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const state = request.nextUrl.searchParams.get("state") ?? "";
  const browser = tokenPattern.test(state) ? request.cookies.get(oauthCookieName(state))?.value : undefined;
  if (!browser || !tokenPattern.test(browser)) {
    return oauthResponse("連携を確認できませんでした", "リンクを開いたブラウザで認可してください。Discordの /niki github からやり直せます。", 400);
  }
  const finish = (title: string, message: string, status = 200) => {
    const response = oauthResponse(title, message, status);
    response.cookies.set(oauthCookieName(state), "", { httpOnly: true, sameSite: "lax", path: "/api/github", maxAge: 0 });
    return response;
  };
  try {
    const store = createStore();
    const session = await store.consumeOAuth(hashToken(state), hashToken(browser));
    if (!session) return finish("リンクが期限切れ、または使用済みです", "Discordで /niki github を再実行してください。", 400);
    if (request.nextUrl.searchParams.has("error")) return finish("GitHub連携を中止しました", "アカウントは変更していません。", 400);
    const code = request.nextUrl.searchParams.get("code");
    if (!code || code.length > 512) return finish("認可コードが無効です", "Discordで /niki github を再実行してください。", 400);
    const identity = await exchangeGitHubCode(code, session.code_verifier);
    await createDiscordClient().assertMember(session.guild_id, session.discord_id);
    // Without TOKEN_ENCRYPTION_KEY the token is simply not kept and checks use the operator token.
    const key = parseTokenKey(process.env.TOKEN_ENCRYPTION_KEY);
    await store.linkGitHub(session.discord_id, session.guild_id, identity.id, identity.login, key ? encryptToken(identity.token, key) : null);
    return finish("GitHubを連携しました", `${identity.login} と連携しました。Discordに戻り、/niki declare で開発内容を宣言できます。`);
  } catch (error) {
    console.error("OAuth callback failed", safeError(error));
    return finish("GitHub連携を完了できませんでした", error instanceof UserError ? error.message : "時間をおいてDiscordで /niki github を再実行してください。", 503);
  }
}
