import { nikiCommand } from "../src/lib/discord/commands.ts";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required (.env.local)`);
  return value;
};
const applicationId = required("DISCORD_APPLICATION_ID");
const token = required("DISCORD_BOT_TOKEN");
const guildId = process.env.DISCORD_GUILD_ID?.trim();
for (const id of [applicationId, guildId].filter(Boolean)) {
  if (!/^\d{17,20}$/.test(id)) throw new Error("Invalid Discord application/guild ID");
}
const path = guildId ? `/applications/${applicationId}/guilds/${guildId}/commands` : `/applications/${applicationId}/commands`;
const command = { ...nikiCommand };
if (guildId) { delete command.contexts; delete command.integration_types; }
// POST upserts this command only, preserving any other commands in the application.
const response = await fetch(`https://discord.com/api/v10${path}`, {
  method: "POST", headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(command), signal: AbortSignal.timeout(15_000),
});
if (!response.ok) throw new Error(`Command registration failed: HTTP ${response.status}`);
console.log(`/niki registered (${guildId ? "guild" : "global"}).`);
const invite = new URL("https://discord.com/oauth2/authorize");
invite.search = new URLSearchParams({ client_id: applicationId, scope: "bot applications.commands", permissions: "84992" }).toString();
console.log(`Install URL: ${invite}`);
