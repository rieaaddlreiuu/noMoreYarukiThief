import { z } from "zod";
import { declarationInput, discordText, formatJst, snowflake, UserError } from "../domain";
import { DeadlineInputError, parseDeadline } from "../deadline";
import type { Store } from "../store";
import { hashToken, randomToken } from "../security";
import type { DiscordClient } from "./client";
import { canSetup } from "./permissions";
import { type Message, statusMessage } from "./messages";

export const interactionSchema = z.object({
  id: snowflake, application_id: snowflake, type: z.literal(2), token: z.string().min(1).max(512),
  guild_id: snowflake, channel_id: snowflake,
  member: z.object({ user: z.object({ id: snowflake }), permissions: z.string().regex(/^\d+$/) }),
  data: z.object({ name: z.literal("niki"), options: z.array(z.object({
    name: z.enum(["setup", "github", "declare", "notify", "cancel", "status"]), type: z.literal(1),
    options: z.array(z.object({ name: z.string(), type: z.number(), value: z.union([z.string(), z.number(), z.boolean()]) })).optional(),
  })).length(1) }),
});
export type Interaction = z.infer<typeof interactionSchema>;
export type CommandDependencies = {
  store: Store;
  discord: DiscordClient;
  origin: () => string;
  validateRepository: (repository: string, branch?: string) => Promise<{ repository: string; branch: string }>;
};

export async function handleCommand(interaction: Interaction, deps: CommandDependencies): Promise<{ message: Message; declarationId?: string }> {
  const guildId = interaction.guild_id;
  const discordId = interaction.member.user.id;
  const command = interaction.data.options[0];
  const options = Object.fromEntries((command.options ?? []).map((option) => [option.name, option.value]));
  if (command.name === "setup") {
    if (!canSetup(interaction.member.permissions)) throw new UserError("初期設定には「サーバー管理」権限が必要です。");
    const channelId = snowflake.parse(options.channel);
    await deps.discord.assertChannel(guildId, channelId);
    await deps.store.setup(guildId, channelId);
    return { message: { content: `通知先を <#${channelId}> に設定しました。各メンバーは /niki github で連携できます。` } };
  }

  await deps.store.requireSetup(guildId);
  if (command.name === "github") {
    const origin = deps.origin();
    const ticket = randomToken();
    await deps.store.issueOAuth(hashToken(ticket), guildId, discordId);
    return { message: { content: `[GitHubアカウントを連携する](${origin}/api/github/start?ticket=${ticket})\nリンクを開き「GitHubで連携する」を押してください。リンクは10分間・1回限り有効です。` } };
  }

  if (command.name === "declare") {
    await deps.store.requireMember(guildId, discordId);
    const parsed = declarationInput.parse(options);
    const deadline = parseDeadline(parsed.deadline);
    const repository = await deps.validateRepository(parsed.repository, parsed.branch);
    const row = await deps.store.createDeclaration({ interactionId: interaction.id, guildId, discordId, content: parsed.content, deadline, ...repository });
    return { declarationId: row.id, message: { content: `宣言を保存しました。通知チャンネルへ投稿します。\n${discordText(row.content)}\n期限: ${formatJst(row.deadline)}\n判定するのは条件に合うコミットの有無です。` } };
  }

  if (command.name === "notify") {
    await deps.store.requireMember(guildId, discordId);
    if (options.reset === true) {
      await deps.store.setNotifyChannel(guildId, discordId, null);
      return { message: { content: "個人の通知先を解除しました。以後の通知はサーバーの既定チャンネルだけに届きます。" } };
    }
    const channelId = interaction.channel_id;
    await deps.discord.assertChannel(guildId, channelId);
    await deps.store.setNotifyChannel(guildId, discordId, channelId);
    return { message: { content: `このチャンネル（<#${channelId}>）を自分の通知先に追加しました。以後の宣言・取消・結果通知は、サーバーの既定チャンネルとここの両方に届きます（作成済みの通知は変わりません）。` } };
  }

  if (command.name === "cancel") {
    const row = await deps.store.cancelDeclaration(guildId, discordId);
    if (!row) throw new UserError("取り消せる宣言がありません。取消できるのは自分の期限前の宣言だけです。");
    return { declarationId: row.id, message: { content: `宣言を取り消しました。判定・集計から除外します。\n${discordText(row.content)}` } };
  }

  const page = z.number().int().min(1).max(1_000_000).default(1).parse(options.page);
  const all = options.all === true;
  if (all && options.member !== undefined) throw new UserError("memberとallは同時に指定できません。");
  const memberId = all ? undefined : options.member === undefined ? discordId : snowflake.parse(options.member);
  const data = await deps.store.teamStatus(guildId);
  if (memberId && !data.members.some((m) => m.discord_id === memberId)) {
    throw new UserError(memberId === discordId ? "あなたはまだ連携していません。/niki github で連携してください。チーム全体は /niki status all:true で見られます。" : "そのユーザーはこのサーバーで連携済みのメンバーではありません。");
  }
  return { message: statusMessage(data.members, data.declarations, page, data.pendingNotifications, new Date(), memberId) };
}

export function commandErrorMessage(error: unknown): string {
  if (error instanceof DeadlineInputError) return error.message;
  if (error instanceof UserError) return error.message;
  if (error instanceof z.ZodError) return "入力形式が正しくありません。内容・owner/repository・日本時間の期限（YYYY-MM-DD HH:mm）を確認してください。";
  return "処理を完了できませんでした。/niki status で保存状況を確認し、時間をおいて再実行してください。";
}
