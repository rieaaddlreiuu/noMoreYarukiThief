import { NextRequest, NextResponse } from "next/server";
import { appOrigin, env } from "@/lib/config";
import { oauthCookieName, oauthResponse, tokenPattern } from "@/lib/oauth-response";
import { hashToken, pkceChallenge, randomToken, safeError } from "@/lib/security";
import { createStore } from "@/lib/store";

export const runtime = "nodejs";

export function GET(request: NextRequest) {
  const ticket = request.nextUrl.searchParams.get("ticket") ?? "";
  if (!tokenPattern.test(ticket)) return oauthResponse("リンクが無効です", "Discordで /niki github を実行し、新しいリンクを開いてください。", 400);
  // Link previews and browser prefetches must not consume the single-use ticket.
  return oauthResponse("GitHubアカウントを連携", "GitHubの認可画面で、ご自身のアカウントを選択してください。", 200, { ticket });
}

export function HEAD(request: NextRequest) {
  const response = GET(request);
  return new NextResponse(null, { status: response.status, headers: response.headers });
}

export async function POST(request: NextRequest) {
  try {
    const origin = appOrigin();
    if (request.headers.get("origin") !== origin) {
      return oauthResponse("連携を開始できませんでした", "Discordのリンクを開き、「GitHubで連携する」を押してください。", 403);
    }
    const form = await request.formData().catch(() => null);
    const ticket = form?.get("ticket");
    if (typeof ticket !== "string" || !tokenPattern.test(ticket)) {
      return oauthResponse("リンクが無効です", "Discordで /niki github を実行し、新しいリンクを開いてください。", 400);
    }
    const clientId = env("GITHUB_CLIENT_ID");
    env("GITHUB_CLIENT_SECRET");
    const state = randomToken();
    const browser = randomToken();
    const verifier = randomToken();
    const valid = await createStore().beginOAuth(hashToken(ticket), hashToken(state), hashToken(browser), verifier);
    if (!valid) return oauthResponse("リンクが期限切れ、または使用済みです", "Discordで /niki github を実行し、新しいリンクを開いてください。", 400);
    const url = new URL("https://github.com/login/oauth/authorize");
    url.search = new URLSearchParams({ client_id: clientId, redirect_uri: `${origin}/api/github/callback`,
      state, scope: "", code_challenge: pkceChallenge(verifier), code_challenge_method: "S256", prompt: "select_account" }).toString();
    // Follow the submitted form with a GET, never forward its POST body to GitHub.
    const response = NextResponse.redirect(url, 303);
    response.cookies.set(oauthCookieName(state), browser, { httpOnly: true, secure: origin.startsWith("https:"), sameSite: "lax", path: "/api/github", maxAge: 600 });
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  } catch (error) {
    console.error("OAuth start failed", safeError(error));
    return oauthResponse("連携を開始できませんでした", "時間をおいてDiscordで /niki github を再実行してください。", 503);
  }
}
