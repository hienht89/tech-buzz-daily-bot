/**
 * Bot quản trị Telegram (Phase 20, Apr 30 2026).
 *
 * Cho phép admin chat trực tiếp với bot qua DM để:
 *   - Xem queue, source health, AI quota, stats hôm nay
 *   - Trigger refill / clear queue / skip slot bằng tay
 *   - Health check
 *
 * Bảo mật:
 *   - Telegram webhook gửi header `X-Telegram-Bot-Api-Secret-Token` (set lúc
 *     setWebhook). Endpoint /telegram/webhook verify header này TRƯỚC khi parse
 *     update — chống abuse.
 *   - Sau khi parse, chỉ chấp nhận lệnh nếu `message.chat.id` === env.TELEGRAM_ADMIN_CHAT_ID.
 *     Chat khác → silent ignore (không reply, tránh leak bot existence).
 *
 * Performance:
 *   - Telegram webhook timeout ~60s. Lệnh nhanh (queue, stats, help) trả lời
 *     trực tiếp. Lệnh chậm (quota probe AI, refill, sources fetch) reply ngay
 *     "đang xử lý..." và làm việc thực tế trong ctx.waitUntil → gửi follow-up
 *     message khi xong. Tránh Telegram retry webhook.
 *
 * Format:
 *   - HTML parse mode (consistent với postArticle/sendAdminAlert).
 *   - Compact text, ≤ 4096 chars/message (Telegram limit).
 *   - Dùng <code>, <b> nhẹ; tránh markdown đặc biệt vì escape phức tạp.
 */

import type { Env } from "./index.js";
import { listQueue } from "./queue.js";
import { fetchAllSources } from "./rss.js";
import { RSS_SOURCES } from "./sources.js";
import { getProviders, type Summary } from "./ai.js";
import { probeProviders } from "./diag.js";
import {
  getAllUsage,
  DEFAULT_QUOTA,
  formatUsage,
  todayKeyUTC,
} from "./bucket.js";
import { getRecentTitles, getLastPosted } from "./storage.js";
import type { Article } from "./rss.js";

// ────────────────────────────────────────────────────────────────────────────
// Telegram Update types (minimal subset bot dùng)
// ────────────────────────────────────────────────────────────────────────────

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  from?: { id: number; username?: string; first_name?: string };
  chat: { id: number; type: string };
  date: number;
  text?: string;
}

/** Callbacks injected by index.ts để admin.ts không phải import vòng. */
export interface AdminCallbacks {
  /** Gọi runQueueRefill và trả về JSON-friendly result. */
  triggerRefill: () => Promise<{
    runId: string;
    refilled: number;
    totalSlots: number;
    skippedExisting: number;
    failed: number;
    reason?: string;
  }>;
}

// ────────────────────────────────────────────────────────────────────────────
// Send reply helper
// ────────────────────────────────────────────────────────────────────────────

async function sendReply(env: Env, chatId: number, text: string): Promise<void> {
  // Telegram giới hạn 4096 char/message → cắt nếu lố (giữ nguyên bot không crash).
  const safe = text.length > 4000 ? text.slice(0, 3990) + "\n…(cắt)" : text;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: safe,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        }),
      },
    );
    if (!res.ok) {
      const body = await res.text();
      console.error(
        `[admin] sendReply HTTP ${res.status}: ${body.slice(0, 300)}`,
      );
    }
  } catch (err) {
    console.error(`[admin] sendReply throw: ${(err as Error).message?.slice(0, 200)}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Main handler
// ────────────────────────────────────────────────────────────────────────────

/**
 * Xử lý 1 update từ Telegram webhook.
 * KHÔNG throw — mọi error đều log + best-effort reply.
 *
 * Trả về void (caller chỉ cần biết handler không crash).
 */
export async function handleTelegramUpdate(
  env: Env,
  update: TelegramUpdate,
  ctx: ExecutionContext,
  callbacks: AdminCallbacks,
): Promise<void> {
  const msg = update.message ?? update.edited_message;
  if (!msg || !msg.text) return; // không phải text message → ignore

  // ───── Authorize ─────
  const adminId = env.TELEGRAM_ADMIN_CHAT_ID?.trim();
  if (!adminId) {
    console.warn("[admin] TELEGRAM_ADMIN_CHAT_ID không set → ignore update.");
    return;
  }
  if (String(msg.chat.id) !== adminId) {
    console.log(
      `[admin] Ignored update from non-admin chat=${msg.chat.id} ` +
        `(from=${msg.from?.username ?? msg.from?.id ?? "?"})`,
    );
    return;
  }

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  // Parse command + args (chỉ xử lý message bắt đầu bằng "/")
  if (!text.startsWith("/")) {
    await sendReply(env, chatId, "Gõ /help để xem danh sách lệnh.");
    return;
  }
  const [cmdRaw, ...args] = text.split(/\s+/);
  // Bỏ @botname suffix nếu có (vd /queue@techbuzz_bot trong group)
  const cmd = cmdRaw.split("@")[0].toLowerCase();

  console.log(`[admin] cmd=${cmd} args=${JSON.stringify(args)} from=${chatId}`);

  try {
    switch (cmd) {
      case "/start":
      case "/help":
        await sendReply(env, chatId, helpText());
        return;

      case "/queue":
        await handleQueue(env, chatId);
        return;

      case "/sources":
        // Slow (~5s fetch all RSS). Ack immediately, do work async.
        await sendReply(env, chatId, "🔍 Đang fetch 27 nguồn… (mất ~5-10s)");
        ctx.waitUntil(handleSources(env, chatId));
        return;

      case "/quota":
        // Slow (~10-30s probe all providers).
        await sendReply(env, chatId, "🔑 Đang probe 9+ AI providers… (mất ~10-30s)");
        ctx.waitUntil(handleQuota(env, chatId));
        return;

      case "/refill":
        await sendReply(env, chatId, "♻️ Đang trigger refill… (mất ~30-90s)");
        ctx.waitUntil(handleRefill(env, chatId, callbacks));
        return;

      case "/clear_queue":
        await handleClearQueue(env, chatId, args);
        return;

      case "/skip":
        await handleSkip(env, chatId, args);
        return;

      case "/stats":
        await handleStats(env, chatId);
        return;

      case "/health":
        await handleHealth(env, chatId);
        return;

      default:
        await sendReply(env, chatId, `Lệnh không nhận diện: <code>${escapeHtml(cmd)}</code>\n\n${helpText()}`);
        return;
    }
  } catch (err) {
    const msg = (err as Error).message?.slice(0, 300) ?? "unknown";
    console.error(`[admin] Handler crashed: cmd=${cmd} err=${msg}`);
    await sendReply(env, chatId, `❌ Lỗi xử lý lệnh: <code>${escapeHtml(msg)}</code>`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Command handlers
// ────────────────────────────────────────────────────────────────────────────

function helpText(): string {
  return (
    `<b>🐝 Tech Buzz Daily — Bot quản trị</b>\n\n` +
    `<b>Xem trạng thái:</b>\n` +
    `/queue — 18 slot sắp đăng\n` +
    `/sources — sức khoẻ 27 nguồn RSS\n` +
    `/quota — trạng thái 9+ AI key\n` +
    `/stats — bài đã đăng hôm nay + bucket usage\n` +
    `/health — ping nhanh\n\n` +
    `<b>Hành động:</b>\n` +
    `/refill — refill queue ngay\n` +
    `/skip &lt;giờ&gt; — bỏ slot (vd /skip 14 = bỏ 14h hôm nay)\n` +
    `/clear_queue YES — XOÁ toàn bộ queue (cần "YES" cuối)\n\n` +
    `<i>Cảnh báo tự động (queue thấp / AI cạn / post fail) sẽ DM tự động.</i>`
  );
}

async function handleQueue(env: Env, chatId: number): Promise<void> {
  const entries = await listQueue(env);
  if (entries.length === 0) {
    await sendReply(env, chatId, `📭 Queue trống.\n\nDùng /refill để fill 18 slot.`);
    return;
  }
  const now = Date.now();
  const lines = entries.map((e) => {
    const dt = new Date(e.payload.scheduledFor);
    const hourVN = (dt.getUTCHours() + 7) % 24;
    const ageMin = Math.round((now - new Date(e.payload.generatedAt).getTime()) / 60000);
    const title = e.payload.summary.title.slice(0, 60);
    const src = e.payload.article.source.slice(0, 12);
    return `${String(hourVN).padStart(2, "0")}h <code>${escapeHtml(src)}</code> — ${escapeHtml(title)} <i>(${ageMin}m)</i>`;
  });
  const header = `📦 <b>Queue: ${entries.length}/18 slot</b>\n<i>Giờ VN — nguồn — tiêu đề (tuổi tóm tắt)</i>\n\n`;
  await sendReply(env, chatId, header + lines.join("\n"));
}

async function handleSources(env: Env, chatId: number): Promise<void> {
  try {
    const { stats } = await fetchAllSources(RSS_SOURCES);
    const ok = stats.filter((s) => s.ok);
    const dead = stats.filter((s) => !s.ok);
    let text = `📡 <b>Sources: ${ok.length}/${stats.length} OK</b>\n\n`;
    if (dead.length > 0) {
      text += `<b>❌ DEAD (${dead.length}):</b>\n`;
      text += dead
        .map((s) => `• <code>${escapeHtml(s.name)}</code>`)
        .join("\n");
      text += "\n\n";
    }
    text += `<b>✅ OK (top 10 nhiều bài nhất):</b>\n`;
    const topOk = [...ok].sort((a, b) => b.count - a.count).slice(0, 10);
    text += topOk
      .map((s) => `• <code>${escapeHtml(s.name)}</code> — ${s.count} bài`)
      .join("\n");
    await sendReply(env, chatId, text);
  } catch (err) {
    await sendReply(env, chatId, `❌ Sources fetch fail: ${escapeHtml((err as Error).message?.slice(0, 200) ?? "?")}`);
  }
}

async function handleQuota(env: Env, chatId: number): Promise<void> {
  try {
    const fakeArticle: Article = {
      title: "Test ping article for AI provider health check",
      link: "https://example.com/diag",
      canonicalUrl: "https://example.com/diag",
      pubDate: new Date(),
      contentSnippet:
        "This is a tiny ping article used to check if AI providers respond. " +
        "OpenAI announced something. The system works. End of test content.",
      source: "diag",
      sourceCategory: "core",
      sourcePriority: 1,
    };
    const providers = getProviders(env);
    const results = await probeProviders(providers, fakeArticle);
    const okCount = results.filter((r) => r.ok).length;
    let text = `🔑 <b>AI Providers: ${okCount}/${providers.length} OK</b>\n\n`;
    text += results
      .map((r) => {
        const icon = r.ok ? "✅" : "❌";
        const ms = r.ms != null ? `${r.ms}ms` : "?ms";
        const err = r.error ? ` — ${escapeHtml(r.error.slice(0, 60))}` : "";
        return `${icon} <code>${escapeHtml(r.provider)}</code> ${ms}${err}`;
      })
      .join("\n");
    await sendReply(env, chatId, text);
  } catch (err) {
    await sendReply(env, chatId, `❌ Quota probe fail: ${escapeHtml((err as Error).message?.slice(0, 200) ?? "?")}`);
  }
}

async function handleRefill(
  env: Env,
  chatId: number,
  callbacks: AdminCallbacks,
): Promise<void> {
  try {
    const r = await callbacks.triggerRefill();
    const text =
      `✅ <b>Refill xong</b>\n\n` +
      `Run ID: <code>${escapeHtml(r.runId)}</code>\n` +
      `Refilled: ${r.refilled}/${r.totalSlots}\n` +
      `Skipped (đã có): ${r.skippedExisting}\n` +
      `Failed: ${r.failed}` +
      (r.reason ? `\nReason: ${escapeHtml(r.reason)}` : "");
    await sendReply(env, chatId, text);
  } catch (err) {
    await sendReply(env, chatId, `❌ Refill crashed: ${escapeHtml((err as Error).message?.slice(0, 300) ?? "?")}`);
  }
}

async function handleClearQueue(
  env: Env,
  chatId: number,
  args: string[],
): Promise<void> {
  if (args[0] !== "YES") {
    await sendReply(
      env,
      chatId,
      `⚠️ <b>Xác nhận xoá queue</b>\n\n` +
        `Lệnh này sẽ XOÁ toàn bộ slot đã queue (kể cả 18 bài đã tóm tắt sẵn).\n` +
        `Sau đó cron post tới slot mới sẽ KHÔNG có bài đăng cho đến khi /refill.\n\n` +
        `Để xác nhận: gửi <code>/clear_queue YES</code>`,
    );
    return;
  }
  try {
    const all = await listQueue(env);
    for (const e of all) {
      await env.POSTED_KV.delete(e.slot);
    }
    await sendReply(env, chatId, `🗑️ Đã xoá <b>${all.length}</b> slot.\nGửi /refill để fill lại.`);
  } catch (err) {
    await sendReply(env, chatId, `❌ Clear fail: ${escapeHtml((err as Error).message?.slice(0, 200) ?? "?")}`);
  }
}

async function handleSkip(
  env: Env,
  chatId: number,
  args: string[],
): Promise<void> {
  // Format: /skip <giờ VN> — vd /skip 14 = bỏ slot 14h hôm nay (= UTC 7h cùng ngày).
  // Nếu giờ đã qua → tìm slot HÔM SAU cùng giờ (vì queue có thể fill 2 ngày).
  const arg = args[0]?.replace(/h$/i, "");
  const hourVN = arg != null ? parseInt(arg, 10) : NaN;
  if (isNaN(hourVN) || hourVN < 7 || hourVN > 24) {
    await sendReply(
      env,
      chatId,
      `⚠️ Cú pháp: <code>/skip &lt;giờ VN&gt;</code>\n` +
        `Giờ hợp lệ: 7-24 (khung post của bot).\n` +
        `Vd <code>/skip 14</code> = bỏ slot 14h hôm nay.`,
    );
    return;
  }

  // VN hour → UTC hour. 7h VN = 0h UTC, 14h VN = 7h UTC, 24h VN = 17h UTC.
  // Note: 24h VN = 0h ngày sau VN = 17h UTC cùng ngày UTC.
  const hourUTC = (hourVN - 7 + 24) % 24;

  // Tìm trong queue slot có giờ UTC khớp.
  const all = await listQueue(env);
  const matches = all.filter((e) => {
    const dt = new Date(e.payload.scheduledFor);
    return dt.getUTCHours() === hourUTC;
  });
  if (matches.length === 0) {
    await sendReply(env, chatId, `⚠️ Không tìm thấy slot ${hourVN}h trong queue.`);
    return;
  }
  // Lấy slot sớm nhất khớp giờ (nếu queue có 2 ngày — vd hôm nay + mai).
  matches.sort((a, b) => a.slot.localeCompare(b.slot));
  const target = matches[0];
  await env.POSTED_KV.delete(target.slot);
  const dt = new Date(target.payload.scheduledFor);
  const dateStr = dt.toISOString().slice(0, 10);
  const title = target.payload.summary.title.slice(0, 80);
  await sendReply(
    env,
    chatId,
    `🗑️ Đã xoá slot <b>${hourVN}h ${dateStr}</b>:\n<i>${escapeHtml(title)}</i>\n\n` +
      `Giờ này sẽ KHÔNG đăng bài (trừ khi /refill chạy lại trước slot).`,
  );
}

async function handleStats(env: Env, chatId: number): Promise<void> {
  const dayKey = todayKeyUTC();
  const usage = await getAllUsage(env, dayKey);
  const total =
    usage.core + usage.ai + usage.dev + usage.research + usage.trend;
  const totalQuota =
    DEFAULT_QUOTA.core +
    DEFAULT_QUOTA.ai +
    DEFAULT_QUOTA.dev +
    DEFAULT_QUOTA.research +
    DEFAULT_QUOTA.trend;
  const recent = await getRecentTitles(env);
  const last = await getLastPosted(env);
  const queue = await listQueue(env);

  let text = `📊 <b>Stats — ${dayKey} (UTC)</b>\n\n`;
  text += `<b>Đã đăng hôm nay:</b> ${total}/${totalQuota}\n`;
  text += `<code>${escapeHtml(formatUsage(usage))}</code>\n\n`;
  text += `<b>Queue hiện tại:</b> ${queue.length}/18 slot\n`;
  text += `<b>Recent titles (KV):</b> ${recent.length}\n\n`;
  if (last) {
    const lastDt = new Date(last.postedAt);
    const ageMin = Math.round((Date.now() - lastDt.getTime()) / 60000);
    text += `<b>Bài đăng gần nhất (${ageMin}m trước):</b>\n`;
    text += `<i>${escapeHtml(last.title.slice(0, 100))}</i>\n`;
    text += `<code>${escapeHtml(last.source)}</code> — score ${last.score}`;
  } else {
    text += `<i>Chưa có bài nào đăng.</i>`;
  }
  await sendReply(env, chatId, text);
}

async function handleHealth(env: Env, chatId: number): Promise<void> {
  const t0 = Date.now();
  let kvOk = false;
  try {
    const probeKey = `__health_admin:${Date.now()}`;
    await env.POSTED_KV.put(probeKey, "1", { expirationTtl: 60 });
    const v = await env.POSTED_KV.get(probeKey);
    kvOk = v === "1";
    await env.POSTED_KV.delete(probeKey);
  } catch (err) {
    console.error(`[admin] health KV fail: ${(err as Error).message}`);
  }
  const ms = Date.now() - t0;
  await sendReply(
    env,
    chatId,
    `${kvOk ? "✅" : "❌"} <b>Health</b>\n\n` +
      `Worker: alive\n` +
      `KV (POSTED_KV): ${kvOk ? "OK" : "FAIL"}\n` +
      `Probe latency: ${ms}ms\n` +
      `Time: <code>${new Date().toISOString()}</code>`,
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Util
// ────────────────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Suppress unused import warnings for types intentionally re-imported for docs/IDE.
export type { Summary };
