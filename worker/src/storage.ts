import type { Env } from "./index.js";
import { normalizeUrl } from "./url.js";
import {
  type RecentTitleEntry,
  RECENT_TITLES_CAP,
  normalizeTitle,
  titleHash as computeTitleHash,
} from "./dedup.js";

const POSTED_PREFIX = "posted:";
const FAIL_PREFIX = "failed:";
const TITLE_PREFIX = "title:";
const RECENT_TITLES_KEY = "recent_titles_v1";

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

/**
 * Hash URL ĐÃ NORMALIZE (strip utm_*, fbclid, fragment, sort params, ...).
 * Đảm bảo cùng 1 article xuất hiện với nhiều variant URL khác nhau (rss vs share
 * vs embedded link với utm khác) sẽ ánh xạ về cùng 1 key.
 */
async function urlHash(url: string): Promise<string> {
  const canonical = normalizeUrl(url);
  const buf = new TextEncoder().encode(canonical);
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

// ────────────────────────────────────────────────────────────────────────────
// Title-based dedup (Layer 1 exact + Layer 2 fuzzy)
// ────────────────────────────────────────────────────────────────────────────

async function titleKey(rawTitle: string): Promise<string> {
  const norm = normalizeTitle(rawTitle);
  return TITLE_PREFIX + (await computeTitleHash(norm));
}

/**
 * Layer 1 exact title dedup: 2 URL khác nhau nhưng cùng normalized title vẫn
 * coi là duplicate (vd repost giữa Verge & TechCrunch cùng wording).
 */
export async function isTitlePosted(env: Env, rawTitle: string): Promise<boolean> {
  if (!rawTitle.trim()) return false;
  const v = await env.POSTED_KV.get(await titleKey(rawTitle));
  return v != null;
}

/**
 * Mark normalized title đã đăng. TTL như URL (30 ngày).
 */
export async function markTitlePosted(env: Env, rawTitle: string): Promise<void> {
  if (!rawTitle.trim()) return;
  await env.POSTED_KV.put(await titleKey(rawTitle), "1", {
    expirationTtl: POSTED_TTL_SECONDS,
  });
}

/**
 * Lấy danh sách title gần nhất (cap RECENT_TITLES_CAP) cho fuzzy dedup.
 * Đọc 1 KV value (JSON array) → 1 read/run, rẻ.
 */
export async function getRecentTitles(env: Env): Promise<RecentTitleEntry[]> {
  const raw = await env.POSTED_KV.get(RECENT_TITLES_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (e): e is RecentTitleEntry =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as RecentTitleEntry).norm === "string" &&
        typeof (e as RecentTitleEntry).raw === "string" &&
        typeof (e as RecentTitleEntry).postedAt === "string",
    );
  } catch {
    return [];
  }
}

/**
 * Push 1 entry vào đầu list, cap về RECENT_TITLES_CAP cũ nhất bị drop.
 * Atomic enough trong Cloudflare KV: vì cron chạy 1 lần/giờ + single-flight
 * mutex, không có race thực tế.
 */
export async function pushRecentTitle(env: Env, rawTitle: string): Promise<void> {
  const norm = normalizeTitle(rawTitle);
  if (!norm) return;
  const list = await getRecentTitles(env);
  const entry: RecentTitleEntry = {
    norm,
    raw: rawTitle,
    postedAt: new Date().toISOString(),
  };
  // Đặt entry mới lên đầu, cap còn RECENT_TITLES_CAP
  const next = [entry, ...list].slice(0, RECENT_TITLES_CAP);
  await env.POSTED_KV.put(RECENT_TITLES_KEY, JSON.stringify(next));
}

// ────────────────────────────────────────────────────────────────────────────
// Last posted snapshot (cho /last endpoint)
// ────────────────────────────────────────────────────────────────────────────

const LAST_POSTED_KEY = "last_posted_v1";

export type LastPostedSnapshot = {
  title: string;
  source: string;
  link: string;
  category: string;
  score: number;
  postedAt: string;
  /** AI provider đã summarize bài này (vd "gemini-2.5-flash", "openrouter-llama"). */
  provider?: string;
};

export async function setLastPosted(env: Env, snap: LastPostedSnapshot): Promise<void> {
  await env.POSTED_KV.put(LAST_POSTED_KEY, JSON.stringify(snap));
}

export async function getLastPosted(env: Env): Promise<LastPostedSnapshot | null> {
  const raw = await env.POSTED_KV.get(LAST_POSTED_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as LastPostedSnapshot;
  } catch {
    return null;
  }
}
