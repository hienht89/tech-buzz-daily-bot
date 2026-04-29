import type { Env } from "./index.js";

const POSTED_PREFIX = "posted:";
const FAIL_PREFIX = "failed:";

// Lưu mỗi URL trong 30 ngày (đủ dài để tránh dupe khi feed cũ vẫn còn quảng bá lại)
const POSTED_TTL_SECONDS = 30 * 24 * 60 * 60;

// Sau khi 1 URL fail liên tiếp MAX_FAIL_BEFORE_SKIP lần, đánh dấu là "poison"
// và bỏ qua trong 24h. Tránh kẹt loop fail mãi cùng 1 bài.
export const MAX_FAIL_BEFORE_SKIP = 3;
const FAIL_TTL_SECONDS = 24 * 60 * 60;

type PostedValue = {
  title: string;
  postedAt: string;
};

async function urlHash(url: string): Promise<string> {
  const buf = new TextEncoder().encode(url);
  const hash = await crypto.subtle.digest("SHA-1", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function postedKey(url: string): Promise<string> {
  return POSTED_PREFIX + (await urlHash(url));
}

async function failKey(url: string): Promise<string> {
  return FAIL_PREFIX + (await urlHash(url));
}

export async function isPosted(env: Env, url: string): Promise<boolean> {
  const v = await env.POSTED_KV.get(await postedKey(url));
  return v != null;
}

/**
 * Đặt chỗ (reserve) URL trong KV NGAY trước khi gửi lên Telegram.
 * Mục đích: nếu một lần chạy khác (vd: cron + manual /run) cũng đang chạy,
 * lần thứ hai khi đọc lại sẽ thấy URL đã được claim → bỏ qua, tránh đăng trùng.
 */
export async function reservePost(
  env: Env,
  url: string,
  title: string,
): Promise<void> {
  const value: PostedValue = {
    title,
    postedAt: new Date().toISOString(),
  };
  await env.POSTED_KV.put(await postedKey(url), JSON.stringify(value), {
    expirationTtl: POSTED_TTL_SECONDS,
  });
}

/**
 * Hủy đặt chỗ nếu việc gửi Telegram thất bại — để lần chạy sau có thể thử lại URL này.
 */
export async function unreservePost(env: Env, url: string): Promise<void> {
  await env.POSTED_KV.delete(await postedKey(url));
}

/**
 * Đếm số lần URL đã fail (Gemini fail, Telegram fail, etc.).
 * Trả về 0 nếu chưa fail lần nào hoặc đã hết TTL.
 */
export async function getFailCount(env: Env, url: string): Promise<number> {
  const v = await env.POSTED_KV.get(await failKey(url));
  if (!v) return 0;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Tăng fail count cho URL, return số mới. Refresh TTL 24h mỗi lần.
 */
export async function incrementFailCount(env: Env, url: string): Promise<number> {
  const current = await getFailCount(env, url);
  const next = current + 1;
  await env.POSTED_KV.put(await failKey(url), String(next), {
    expirationTtl: FAIL_TTL_SECONDS,
  });
  return next;
}

/**
 * Xóa fail count khi URL post thành công.
 */
export async function clearFailCount(env: Env, url: string): Promise<void> {
  await env.POSTED_KV.delete(await failKey(url));
}
