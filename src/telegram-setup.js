// Helper: finds your Telegram chat ID and sends a test message.
//   npm run telegram        (npm.cmd run telegram on Windows PowerShell)
import { config } from "./config.js";

const { token, chatId, baseUrl } = config.telegram;
const say = (s) => console.log(s);

if (!token) {
  say("\nTELEGRAM_BOT_TOKEN is empty in .env.");
  say("1) In Telegram, open @BotFather, send /newbot and follow the steps.");
  say("2) Copy the token it gives you into TELEGRAM_BOT_TOKEN= in .env, save, and run this again.\n");
  process.exit(1);
}

async function call(method, body) {
  const res = await fetch(`${baseUrl}/bot${token}/${method}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.description || `Telegram answered ${res.status}`);
  return data.result;
}

try {
  const me = await call("getMe");
  say(`\nBot found: @${me.username} (${me.first_name})`);

  if (chatId) {
    await call("sendMessage", { chat_id: chatId, text: `✅ ${config.company} is connected. Alerts will arrive here.` });
    say(`Test message sent to chat ${chatId}. Check Telegram!\n`);
    process.exit(0);
  }

  const updates = await call("getUpdates");
  const chats = new Map();
  for (const u of updates) {
    const c = (u.message || u.channel_post || u.my_chat_member || {}).chat;
    if (c) chats.set(c.id, c.title || [c.first_name, c.last_name].filter(Boolean).join(" ") || c.username || c.type);
  }
  if (!chats.size) {
    say(`\nNo messages found yet. In Telegram, open @${me.username}, press Start and send it "hi"`);
    say("(for a group: add the bot to the group and send a message there). Then run this again.\n");
    process.exit(1);
  }
  say("\nChats that messaged the bot:");
  for (const [id, name] of chats) say(`  ${id}   ${name}`);
  say("\nCopy the number for your chat into TELEGRAM_CHAT_ID= in .env, save, and run this again to send a test message.\n");
} catch (e) {
  say("\nTelegram error: " + e.message);
  say("Check that TELEGRAM_BOT_TOKEN is copied exactly from @BotFather.\n");
  process.exit(1);
}
