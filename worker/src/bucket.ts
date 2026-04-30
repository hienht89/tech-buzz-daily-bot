/**
 * Bucket selection — cap số bài/category để 1 nhóm không dominate.
 *
 * Quota mặc định (Phase 19.6, Apr 30 2026 — nới rộng để hỗ trợ "always-post"):
 *   core     = 8   (↑ từ 6 — báo lớn ổn định, ưu tiên cao nhất)
 *   ai       = 7   (↑ từ 5)
 *   dev      = 6   (↑ từ 4)
 *   research = 3   (↑ từ 1 — đêm Mỹ thường chỉ còn arxiv tươi)
 *   trend    = 4   (↑ từ 2)
 *   ──────────────
 *   total    = 28  (cap rộng; cron 18 tick/ngày → vẫn không bao giờ chạm cap)
 *
 * Lý do tăng (Phase 19.6): user yêu cầu ĐÚNG 18 bài/ngày, không miss slot.
 * Quota cũ 1/2 cho research/trend tạo bottleneck trong giờ tin yếu (vd 10h-14h
 * trưa VN = đêm Mỹ): nếu RSS lúc đó chỉ còn arxiv tươi mà research đã full
 * → bucket eligible = 0 → rơi vào fallback (highest score chung). Nới quota
 * vẫn cho phép fallback hoạt động nhưng giảm tần suất phải fallback.
 *
 * Vẫn là CAP chứ không phải allocation: cron 18 tick + cap 28 → mỗi category
 * có dư địa nhưng không thể chiếm hết. Cap chỉ kick in khi:
 *   - 1 category có rất nhiều news ngon → cần phân bổ sang category khác
 *   - manual trigger nhiều lần ngoài cron
 *
 * Mỗi tick cron → chạy 1 lần → đăng tối đa 1 bài. Ta chọn:
 *   1. Bucket nào còn quota → ưu tiên
 *   2. Trong các bucket còn quota, lấy candidate có score cao nhất
 *   3. Nếu TẤT CẢ bucket hết quota → fallback: chọn highest score chung
 *
 * Quota track trong KV: `quota:YYYY-MM-DD:<category>` → số bài đã đăng.
 * TTL 48h (qua ngày tự reset, vẫn lưu phòng debug 1 ngày).
 */

import type { Env } from "./index.js";
import type { Article } from "./rss.js";
import type { SourceCategory } from "./sources.js";

// ────────────────────────────────────────────────────────────────────────────

/** Quota mặc định mỗi ngày, tổng = 28 (cap rộng, không phải target — xem comment top file). */
export const DEFAULT_QUOTA: Record<SourceCategory, number> = {
  core: 8,
  ai: 7,
  dev: 6,
  research: 3,
  trend: 4,
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
