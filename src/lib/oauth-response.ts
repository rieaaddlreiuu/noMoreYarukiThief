import { NextResponse } from "next/server";

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
export const oauthCookieName = (state: string) => `niki_oauth_${state.slice(0, 16)}`;
export const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

export function oauthResponse(title: string, message: string, status = 200, form?: { ticket: string }) {
  const action = form
    ? `<form action="/api/github/start" method="post"><input type="hidden" name="ticket" value="${escape(form.ticket)}"><button type="submit">GitHubで連携する</button></form>`
    : "<p>このタブは閉じられます。</p>";
  return new NextResponse(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} | 開発ニキ</title><style>
    :root{color-scheme:light dark}body{margin:0;background:#fafbfc;color:#202630;font:16px/1.8 system-ui,sans-serif}main{max-width:640px;margin:48px auto;padding:0 24px}h1{font-size:24px;margin:0 0 16px}p{margin:0 0 12px}@media(prefers-color-scheme:dark){body{background:#161a20;color:#e9edf2}}
    button{font:inherit;padding:8px 16px;border:1px solid #9aa6b3;border-radius:4px;background:#cceeff;color:#202630;cursor:pointer}
    </style></head><body><main><h1>${escape(title)}</h1><p>${escape(message)}</p>${action}</main></body></html>`, {
    status, headers: {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      // Preserve Origin on the local form POST without sharing the ticket with GitHub.
      "Referrer-Policy": form ? "same-origin" : "no-referrer",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://github.com",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
