import type { Env } from "./index.js";

const KEY_PREFIX = "posted:";
// Lưu mỗi URL trong 30 ngày (đủ dài để tránh dupe khi feed cũ vẫn còn quảng bá lại)
const TTL_SECONDS = 30 * 24 * 60 * 60;

type PostedValue = {
  title: string;
  postedAt: string;
};

async function urlKey(url: string): Promise<string> {
  const buf = new TextEncoder().encode(url);
  const hash = await crypto.subtle.digest("SHA-1", buf);
  const hex = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return KEY_PREFIX + hex;
}

export async function isPosted(env: Env, url: string): Promise<boolean> {
  const key = await urlKey(url);
  const v = await env.POSTED_KV.get(key);
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
  const key = await urlKey(url);
  const value: PostedValue = {
    title,
    postedAt: new Date().toISOString(),
  };
  await env.POSTED_KV.put(key, JSON.stringify(value), {
    expirationTtl: TTL_SECONDS,
  });
}

/**
 * Hủy đặt chỗ nếu việc gửi Telegram thất bại — để lần chạy sau có thể thử lại URL này.
 */
export async function unreservePost(env: Env, url: string): Promise<void> {
  const key = await urlKey(url);
  await env.POSTED_KV.delete(key);
}
