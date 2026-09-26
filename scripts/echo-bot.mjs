import { Client, Events, GatewayIntentBits } from "discord.js";

const token = process.env.DISCORD_BOT_TOKEN;
const channelId = process.env.ECHO_CHANNEL_ID;
if (!token || !channelId) {
  console.error("DISCORD_BOT_TOKEN and ECHO_CHANNEL_ID are required.");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  allowedMentions: { parse: [] },
});

client.once(Events.ClientReady, (c) => console.log(`ready: ${c.user.tag}`));

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || message.channelId !== channelId || !message.content) return;
  try {
    await message.channel.send(message.content);
  } catch (error) {
    console.error("echo failed:", error);
  }
});

await client.login(token);
