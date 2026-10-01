import "server-only";
import { createClient } from "@supabase/supabase-js";
import { env } from "./config";
import { UserError, type Declaration, type Member, type Notification } from "./domain";

type DbResult = { data: unknown; error: { code?: string; message: string } | null };
export type OAuthSession = { discord_id: string; guild_id: string; code_verifier: string };

export interface JobStore {
  claimCheck(): Promise<Declaration | null>;
  finishCheck(row: Declaration, sha: string | null, aiReason?: string, judged?: string[]): Promise<boolean>;
  retryCheck(row: Declaration, error: string, delay: number): Promise<void>;
  claimNotification(declarationId?: string): Promise<Notification | null>;
  getDeclaration(id: string): Promise<Declaration>;
  finishNotification(row: Notification, messageId: string): Promise<boolean>;
  retryNotification(row: Notification, error: string, delay: number): Promise<void>;
}

export function createStore() {
  const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(8_000) }) },
  });

  async function query<T>(request: PromiseLike<DbResult>): Promise<T> {
    const { data, error } = await request;
    if (error) {
      if (error.message.includes("LINK_REQUIRED")) throw new UserError("先に /niki github でGitHubを連携してください。");
      if (error.message.includes("SETUP_REQUIRED")) throw new UserError("管理者が先に /niki setup を実行してください。");
      if (error.message.includes("FUTURE_DEADLINE_REQUIRED")) throw new UserError("期限が過ぎました。現在より後の期限を入力してください。");
      // Never expose PostgREST details, SQL values, or credentials to Discord/logs.
      throw new Error(`Database operation failed (${error.code ?? "unknown"})`);
    }
    return data as T;
  }

  const rpc = <T>(name: string, args: Record<string, unknown> = {}) => query<T>(db.rpc(name, args));
  const first = async <T>(request: Promise<T[]>) => (await request)[0] ?? null;

  return {
    async claimInteraction(id: string) {
      const { error } = await db.from("interaction_receipts").insert({ id });
      if (error?.code === "23505") return false;
      if (error) throw new Error("Could not record interaction");
      return true;
    },
    async setup(guildId: string, channelId: string) {
      await query(db.from("guild_settings").upsert({ guild_id: guildId, channel_id: channelId, updated_at: new Date().toISOString() }));
    },
    async requireSetup(guildId: string) {
      const row = await query<{ channel_id: string } | null>(db.from("guild_settings").select("channel_id").eq("guild_id", guildId).maybeSingle());
      if (!row) throw new UserError("管理者が先に /niki setup で通知先を設定してください。");
      return row;
    },
    async requireMember(guildId: string, discordId: string) {
      const row = await query<{ discord_id: string } | null>(db.from("memberships").select("discord_id").eq("guild_id", guildId).eq("discord_id", discordId).eq("active", true).maybeSingle());
      if (!row) throw new UserError("このサーバーで /niki github を実行してGitHubを連携してください。");
    },
    async setNotifyChannel(guildId: string, discordId: string, channelId: string | null) {
      await rpc("niki_set_notify_channel", { p_guild_id: guildId, p_discord_id: discordId, p_channel_id: channelId });
    },
    async issueOAuth(ticketHash: string, guildId: string, discordId: string) {
      await query(db.from("oauth_sessions").insert({ ticket_hash: ticketHash, guild_id: guildId, discord_id: discordId }));
    },
    beginOAuth(ticketHash: string, stateHash: string, browserHash: string, verifier: string) {
      return rpc<boolean>("niki_begin_oauth", { p_ticket_hash: ticketHash, p_state_hash: stateHash, p_browser_hash: browserHash, p_verifier: verifier });
    },
    consumeOAuth(stateHash: string, browserHash: string) {
      return first(rpc<OAuthSession[]>("niki_consume_oauth", { p_state_hash: stateHash, p_browser_hash: browserHash }));
    },
    async linkGitHub(discordId: string, guildId: string, githubId: number, login: string, tokenEnc: string | null = null) {
      const { error } = await db.rpc("niki_link_github", { p_discord_id: discordId, p_guild_id: guildId, p_github_id: githubId, p_login: login, p_token_enc: tokenEnc });
      if (error?.code === "23505") throw new UserError("このGitHubアカウントは別のDiscordユーザーと連携済みです。");
      if (error) throw new Error("Could not save GitHub link");
    },
    async getGitHubToken(discordId: string) {
      const row = await query<{ github_token_enc: string | null } | null>(db.from("users").select("github_token_enc").eq("discord_id", discordId).maybeSingle());
      return row?.github_token_enc ?? null;
    },
    async clearGitHubToken(discordId: string) {
      await query(db.from("users").update({ github_token_enc: null }).eq("discord_id", discordId));
    },
    async createDeclaration(input: { interactionId: string; guildId: string; discordId: string; content: string; repository: string; branch: string; deadline: string }) {
      const result = await db.rpc("niki_create_declaration", {
        p_interaction_id: input.interactionId, p_guild_id: input.guildId, p_discord_id: input.discordId,
        p_content: input.content, p_repository: input.repository, p_branch: input.branch, p_deadline: input.deadline,
      }).single();
      if (result.error?.code === "23505") throw new UserError("進行中の宣言があります。/niki status で確認してください。");
      return query<Declaration>(Promise.resolve(result));
    },
    cancelDeclaration(guildId: string, discordId: string) {
      return first(rpc<Declaration[]>("niki_cancel_declaration", { p_guild_id: guildId, p_discord_id: discordId }));
    },
    async teamStatus(guildId: string) {
      const rawMembers = await query<{ discord_id: string; users: { github_login: string } }[]>(
        db.from("memberships").select("discord_id, users!inner(github_login)").eq("guild_id", guildId).eq("active", true).order("joined_at"),
      );
      const members: Member[] = rawMembers.map((m) => ({ discord_id: m.discord_id, github_login: m.users.github_login }));
      const declarations: Declaration[] = [];
      // Supabase caps individual responses: page history so rates never silently lose old results.
      for (let offset = 0; ; offset += 500) {
        const page = await query<Declaration[]>(db.from("declarations").select("*").eq("guild_id", guildId)
          .order("created_at", { ascending: false }).order("id").range(offset, offset + 499));
        declarations.push(...page);
        if (page.length < 500) break;
      }
      const pendingNotifications = await query<{ id: string }[]>(db.from("notifications")
        .select("id, declarations!inner(guild_id)").eq("declarations.guild_id", guildId).eq("status", "pending"));
      return { members, declarations, pendingNotifications: pendingNotifications.length };
    },
    cleanup() { return rpc<void>("niki_cleanup"); },
    claimCheck() { return first(rpc<Declaration[]>("niki_claim_check")); },
    finishCheck(row: Declaration, sha: string | null, aiReason?: string, judged?: string[]) {
      return rpc<boolean>("niki_finish_check", { p_id: row.id, p_lease: row.lease_token, p_sha: sha, p_ai_reason: aiReason ?? null, p_judged: judged ?? null });
    },
    retryCheck(row: Declaration, error: string, delay: number) {
      return rpc<void>("niki_retry_check", { p_id: row.id, p_lease: row.lease_token, p_error: error, p_delay: delay });
    },
    claimNotification(declarationId?: string) {
      return first(rpc<Notification[]>("niki_claim_notification", { p_declaration_id: declarationId ?? null }));
    },
    getDeclaration(id: string) {
      return query<Declaration>(db.from("declarations").select("*").eq("id", id).single());
    },
    finishNotification(row: Notification, messageId: string) {
      return rpc<boolean>("niki_finish_notification", { p_id: row.id, p_lease: row.lease_token, p_message_id: messageId });
    },
    retryNotification(row: Notification, error: string, delay: number) {
      return rpc<void>("niki_retry_notification", { p_id: row.id, p_lease: row.lease_token, p_error: error, p_delay: delay });
    },
  };
}

export type Store = ReturnType<typeof createStore>;
