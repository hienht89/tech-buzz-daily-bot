/**
 * Bucket selection — đảm bảo 18 bài/ngày trải đều theo category.
 *
 * Quota mặc định:
 *   core     = 5
 *   ai       = 5
 *   dev      = 4
 *   research = 2
 *   trend    = 2
 *   ──────────────
 *   total    = 18  (khớp cron `0 0-17 * * *` UTC = 18 lần/ngày)
 *
 * Mỗi giờ cron tick → chạy 1 lần → đăng tối đa 1 bài. Ta chọn:
 *   1. Bucket nào còn quota → ưu tiên
 *   2. Trong các bucket còn quota, lấy candidate có score cao nhất
 *   3. Nếu TẤT CẢ bucket hết quota → fallback: chọn highest score chung
 *      (ngày hôm đó đã đủ 18, run sau cron có thể được trigger thủ công)
 *
 * Quota track trong KV: `quota:YYYY-MM-DD:<category>` → số bài đã đăng.
 * TTL 48h (qua ngày tự reset, vẫn lưu phòng debug 1 ngày).
 */

import type { Env } from "./index.js";
import type { Article } from "./rss.js";
import type { SourceCategory } from "./sources.js";

// ────────────────────────────────────────────────────────────────────────────

/** Quota mặc định mỗi ngày, tổng = 18. */
export const DEFAULT_QUOTA: Record<SourceCategory, number> = {
  core: 5,
  ai: 5,
  dev: 4,
  research: 2,
  trend: 2,
};

const QUOTA_PREFIX = "quota:";
const QUOTA_TTL_SECONDS = 48 * 60 * 60;

/** Trả YYYY-MM-DD theo UTC (cron của Cloudflare là UTC). */
export function todayKeyUTC(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function quotaKey(category: SourceCategory, dayKey: string): string {
  return `${QUOTA_PREFIX}${dayKey}:${category}`;
}

/**
 * Đọc usage hiện tại của 1 category trong ngày. Default 0.
 */
export async function getCategoryUsage(
  env: Env,
  category: SourceCategory,
  dayKey: string,
): Promise<number> {
  const v = await env.POSTED_KV.get(quotaKey(category, dayKey));
  if (!v) return 0;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Đọc usage tất cả category song song. 1 read/category = 5 reads tổng.
 */
export async function getAllUsage(
  env: Env,
  dayKey: string,
): Promise<Record<SourceCategory, number>> {
  const cats: SourceCategory[] = ["core", "ai", "dev", "research", "trend"];
  const values = await Promise.all(cats.map((c) => getCategoryUsage(env, c, dayKey)));
  const out = {} as Record<SourceCategory, number>;
  cats.forEach((c, i) => {
    out[c] = values[i];
  });
  return out;
}

/**
 * Tăng usage của 1 category. Refresh TTL 48h.
 */
export async function incrementCategoryUsage(
  env: Env,
  category: SourceCategory,
  dayKey: string,
): Promise<number> {
  const current = await getCategoryUsage(env, category, dayKey);
  const next = current + 1;
  await env.POSTED_KV.put(quotaKey(category, dayKey), String(next), {
    expirationTtl: QUOTA_TTL_SECONDS,
  });
  return next;
}

// ────────────────────────────────────────────────────────────────────────────
// Selection logic
// ────────────────────────────────────────────────────────────────────────────

export type BucketSelectionResult = {
  /** Article được chọn (đã pass dedup, đã có score). null nếu không có ứng cử viên. */
  picked: Article | null;
  /** Bucket được chọn từ đâu. null nếu picked = null. */
  pickedFrom: SourceCategory | null;
  /** Có phải fallback (tất cả bucket đã đầy quota) hay không. */
  fallback: boolean;
  /** Snapshot usage để log. */
  usage: Record<SourceCategory, number>;
  /** Snapshot quota để log. */
  quota: Record<SourceCategory, number>;
};

/**
 * Chọn 1 bài từ batch candidates theo bucket strategy.
 *
 * Yêu cầu: candidates ĐÃ qua filter + dedup, ĐÃ được scored (article.score set),
 * và sorted DESC theo score (caller responsibility — algorithm vẫn đúng nếu
 * không sort, chỉ chậm hơn chút vì duyệt đầy đủ).
 *
 * Pure-ish: đọc usage qua param, KHÔNG ghi KV. Caller chịu trách nhiệm
 * incrementCategoryUsage SAU KHI post thành công.
 */
export function selectFromBuckets(
  candidates: readonly Article[],
  usage: Record<SourceCategory, number>,
  quota: Record<SourceCategory, number> = DEFAULT_QUOTA,
): BucketSelectionResult {
  if (candidates.length === 0) {
    return { picked: null, pickedFrom: null, fallback: false, usage, quota };
  }

  // 1. Tính remaining cho mỗi bucket
  const remaining: Record<SourceCategory, number> = {
    core: Math.max(0, quota.core - (usage.core ?? 0)),
    ai: Math.max(0, quota.ai - (usage.ai ?? 0)),
    dev: Math.max(0, quota.dev - (usage.dev ?? 0)),
    research: Math.max(0, quota.research - (usage.research ?? 0)),
    trend: Math.max(0, quota.trend - (usage.trend ?? 0)),
  };

  // 2. Lọc candidates thuộc bucket còn remaining > 0
  const eligible = candidates.filter((a) => remaining[a.sourceCategory] > 0);

  if (eligible.length > 0) {
    // 3a. Pick highest score trong eligible
    const winner = pickHighestScore(eligible);
    return {
      picked: winner,
      pickedFrom: winner.sourceCategory,
      fallback: false,
      usage,
      quota,
    };
  }

  // 3b. Fallback: tất cả bucket đầy → pick highest score chung
  const winner = pickHighestScore(candidates);
  return {
    picked: winner,
    pickedFrom: winner.sourceCategory,
    fallback: true,
    usage,
    quota,
  };
}

function pickHighestScore(arr: readonly Article[]): Article {
  let best = arr[0];
  let bestScore = best.score ?? -Infinity;
  for (let i = 1; i < arr.length; i++) {
    const s = arr[i].score ?? -Infinity;
    if (s > bestScore) {
      best = arr[i];
      bestScore = s;
    }
  }
  return best;
}

/**
 * Format usage/quota cho log: "core 2/5, ai 5/5(full), dev 1/4, research 0/2, trend 1/2"
 */
export function formatUsage(
  usage: Record<SourceCategory, number>,
  quota: Record<SourceCategory, number> = DEFAULT_QUOTA,
): string {
  const cats: SourceCategory[] = ["core", "ai", "dev", "research", "trend"];
  return cats
    .map((c) => {
      const u = usage[c] ?? 0;
      const q = quota[c];
      const tag = u >= q ? "(full)" : "";
      return `${c} ${u}/${q}${tag}`;
    })
    .join(", ");
}
