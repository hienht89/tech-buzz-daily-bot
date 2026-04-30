/**
 * Cảnh báo proactive cho admin (DM Telegram).
 *
 * Phase 20 (Apr 30 2026): bot tự gửi tin nhắn DM cho admin khi phát hiện
 * sự cố — admin không cần ngồi check dashboard. Mỗi loại alert có throttle
 * riêng (KV TTL) để tránh spam điện thoại khi sự cố kéo dài.
 *
 * Throttle implementation:
 *   - Key KV: `alert:throttle:<type>` với TTL = ALERT_THROTTLE_HOURS giờ.
 *   - Trước khi gửi: kiểm tra key tồn tại → bỏ qua.
 *   - Sau khi gửi thành công: ghi key với TTL.
 *   - Lỗi đọc/ghi KV → vẫn cố gửi alert (better safe than sorry).
 *
 * Tất cả function ở đây đều no-throw — nếu env.TELEGRAM_ADMIN_CHAT_ID
 * không set hoặc Telegram fail → log + return false, KHÔNG ảnh hưởng
 * pipeline chính (post / refill).
 */

import { sendAdminAlert } from "./telegram.js";
import type { Env } from "./index.js";

/** Mỗi loại alert tối đa 1 lần / 6h để tránh spam khi sự cố kéo dài. */
const ALERT_THROTTLE_HOURS = 6;
const ALERT_THROTTLE_TTL_SEC = ALERT_THROTTLE_HOURS * 3600;

export type AlertType =
  | "queue_low"
  | "ai_keys_exhausted"
  | "post_failures"
  | "refill_failed";

function throttleKey(type: AlertType): string {
  return `alert:throttle:${type}`;
}

/**
 * Kiểm tra throttle: nếu KV có key cho type này → đã alert gần đây, return true (skip).
 * Lỗi KV → return false (cho phép alert, ưu tiên không miss).
 */
async function isThrottled(env: Env, type: AlertType): Promise<boolean> {
  try {
    const v = await env.POSTED_KV.get(throttleKey(type));
    return v !== null;
  } catch (err) {
    console.warn(
      `[alerts] Throttle read fail (assume not throttled): ${(err as Error).message?.slice(0, 200)}`,
    );
    return false;
  }
}

async function markThrottled(env: Env, type: AlertType): Promise<void> {
  try {
    await env.POSTED_KV.put(throttleKey(type), new Date().toISOString(), {
      expirationTtl: ALERT_THROTTLE_TTL_SEC,
    });
  } catch (err) {
    console.warn(
      `[alerts] Throttle write fail: ${(err as Error).message?.slice(0, 200)}`,
    );
  }
}

/**
 * Wrapper chung: throttle check → sendAdminAlert → mark throttled.
 * Trả về true nếu đã gửi, false nếu skip (throttled hoặc env không set).
 */
async function sendThrottledAlert(
  env: Env,
  type: AlertType,
  text: string,
): Promise<boolean> {
  if (await isThrottled(env, type)) {
    console.log(`[alerts] Skip ${type} alert (throttled, max 1/${ALERT_THROTTLE_HOURS}h).`);
    return false;
  }
  const sent = await sendAdminAlert(env, text);
  if (sent) {
    await markThrottled(env, type);
    console.log(`[alerts] Sent ${type} alert to admin.`);
  }
  return sent;
}

// ────────────────────────────────────────────────────────────────────────────
// Alert sites
// ────────────────────────────────────────────────────────────────────────────

/**
 * Refill xong nhưng queue thấp (< MIN_QUEUE_OK = 6).
 * Có thể do: nguồn RSS yếu, AI quota cạn, hoặc filter quá khắt.
 */
export async function alertQueueLow(
  env: Env,
  queueLen: number,
  refilled: number,
  totalSlots: number,
  failed: number,
): Promise<boolean> {
  const text =
    `⚠️ <b>Queue thấp sau refill</b>\n\n` +
    `Queue hiện tại: <b>${queueLen} bài</b>\n` +
    `Refill vừa rồi: ${refilled}/${totalSlots} slot (failed=${failed})\n\n` +
    `Có thể do: nguồn RSS yếu hôm nay, AI quota cạn, hoặc filter loại quá nhiều.\n` +
    `Gửi /sources xem nguồn nào chết, /quota xem AI key.`;
  return sendThrottledAlert(env, "queue_low", text);
}

/**
 * Phần lớn AI key đã cạn quota — refill failed quá nhiều và hầu hết là lỗi 429.
 */
export async function alertAiKeysExhausted(
  env: Env,
  failedCount: number,
  totalSlots: number,
): Promise<boolean> {
  const text =
    `🔑 <b>AI quota cạn</b>\n\n` +
    `Refill vừa rồi failed <b>${failedCount}/${totalSlots} slot</b> — phần lớn do quota AI.\n\n` +
    `Khả năng cao: nhiều key Gemini đã cạn quota daily.\n` +
    `Quota Gemini reset 0h Pacific = 14h-15h VN. Đợi reset hoặc thêm key mới.\n\n` +
    `Gửi /quota để check chi tiết từng key.`;
  return sendThrottledAlert(env, "ai_keys_exhausted", text);
}

/**
 * Post fail liên tiếp ≥ 3 tick → có thể queue trống hoặc Telegram API issue.
 */
export async function alertConsecutivePostFailures(
  env: Env,
  failStreak: number,
  lastReason: string,
): Promise<boolean> {
  const text =
    `❌ <b>Post fail liên tiếp ${failStreak} lần</b>\n\n` +
    `Lý do gần nhất: ${escapeHtml(lastReason).slice(0, 300)}\n\n` +
    `Có thể do: queue trống (refill chưa chạy), Telegram API down, ` +
    `hoặc TELEGRAM_BOT_TOKEN sai.\n\n` +
    `Gửi /queue xem queue, /health ping kiểm tra.`;
  return sendThrottledAlert(env, "post_failures", text);
}

/**
 * Refill cron throw exception (toàn bộ refill chết, không enqueue được gì).
 */
export async function alertRefillFailed(
  env: Env,
  errorMsg: string,
): Promise<boolean> {
  const text =
    `💥 <b>Refill cron CRASH</b>\n\n` +
    `Lỗi: ${escapeHtml(errorMsg).slice(0, 400)}\n\n` +
    `Toàn bộ refill thất bại — queue có thể trống. ` +
    `Thử gửi /refill để kích hoạt lại bằng tay.`;
  return sendThrottledAlert(env, "refill_failed", text);
}

// ────────────────────────────────────────────────────────────────────────────
// Counter helpers (post failure streak — không phải throttle, là state)
// ────────────────────────────────────────────────────────────────────────────

const POST_FAIL_STREAK_KEY = "alert:postfail:streak";

export async function incrementPostFailStreak(env: Env): Promise<number> {
  try {
    const cur = await env.POSTED_KV.get(POST_FAIL_STREAK_KEY);
    const next = (cur ? parseInt(cur, 10) : 0) + 1;
    await env.POSTED_KV.put(POST_FAIL_STREAK_KEY, String(next));
    return next;
  } catch (err) {
    console.warn(
      `[alerts] Post-fail streak inc fail: ${(err as Error).message?.slice(0, 200)}`,
    );
    return 0;
  }
}

export async function resetPostFailStreak(env: Env): Promise<void> {
  try {
    await env.POSTED_KV.delete(POST_FAIL_STREAK_KEY);
  } catch (err) {
    console.warn(
      `[alerts] Post-fail streak reset fail: ${(err as Error).message?.slice(0, 200)}`,
    );
  }
}

export const POST_FAIL_ALERT_THRESHOLD = 3;

// ────────────────────────────────────────────────────────────────────────────
// Util
// ────────────────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
