// Telegram alerts through a bot (https://core.telegram.org/bots/api). Free.
// Messages are queued and sent about one per second.

export function createTelegram({ token, chatId, baseUrl, notify }) {
  const enabled = !!(token && chatId);
  const want = new Set(String(notify || "").split(",").map((s) => s.trim()).filter(Boolean));
  const queue = [];
  let busy = false;
  const health = { ok: enabled ? null : null, lastOk: null, error: enabled ? null : "off" };

  async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const text = queue.shift();
      try {
        const res = await fetch(`${baseUrl}/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        });
        const data = await res.json().catch(() => ({}));
        if (!data.ok) throw new Error(data.description || `Telegram answered ${res.status}`);
        health.ok = true; health.lastOk = new Date().toISOString(); health.error = null;
      } catch (e) {
        health.ok = false; health.error = e.message;
        console.error("[telegram]", e.message);
      }
      await new Promise((r) => setTimeout(r, 1100));
    }
    busy = false;
  }

  return {
    enabled,
    health,
    wants: (kind) => enabled && want.has(kind),
    send(text) {
      if (!enabled) return;
      queue.push(String(text).slice(0, 3900));
      if (queue.length > 50) queue.splice(0, queue.length - 50);
      pump();
    },
  };
}
