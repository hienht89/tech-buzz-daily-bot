/**
 * Scoring engine — gán điểm cho từng article để bucket selection chọn bài
 * tốt nhất trong từng bucket.
 *
 * Mục tiêu thiết kế:
 * - DETERMINISTIC: cùng input → cùng score (test được, debug được).
 * - DIAGNOSTIC: trả breakdown (`scoreParts`) để log "vì sao bài này thắng".
 * - CONFIGURABLE: weight ở top file, dễ chỉnh khi thấy lệch.
 *
 * Final score là tổng các thành phần — không nhân, không power. Cố tình giữ
 * tuyến tính để dễ explain.
 */

import type { Article } from "./rss.js";
// LƯU Ý: dùng .ts extension trực tiếp vì test runner Node `--experimental-strip-types`
// KHÔNG tự rewrite ".js → .ts" cho VALUE import nội bộ giữa src/ files. Tests load
// score.ts → trigger filter.ts resolve → .js không tồn tại trên disk.
// wrangler/esbuild build production accept cả 2 extension nên không ảnh hưởng deploy.
import { keywordScore } from "./filter.ts";

// ────────────────────────────────────────────────────────────────────────────
// Weight config — chỉnh ở đây nếu muốn đổi cân bằng
// ────────────────────────────────────────────────────────────────────────────

/** Điểm theo source priority (1=primary lab, 2=quality outlet, 3=aggregator). */
const SOURCE_WEIGHT: Record<1 | 2 | 3, number> = {
  1: 100,
  2: 70,
  3: 40,
};

/** Recency: bài fresh trong 0h → 100, sau 48h → 0. Linear decay. */
const RECENCY_MAX = 100;
const RECENCY_WINDOW_HOURS = 48;

/** Tên các nguồn được coi là "primary lab" (nhận thêm boost vượt sourceWeight). */
const PRIMARY_LAB_SOURCES: ReadonlySet<string> = new Set([
  "OpenAI Blog",
  "Google AI Blog",
  "DeepMind Blog",
  "Anthropic News",
  "Meta AI Blog",
  "Hugging Face Blog",
]);
const PRIMARY_LAB_BOOST = 30;

/** Tên các nguồn engineering blog mang tính 1st-party kỹ thuật. */
const ENGINEERING_BLOG_SOURCES: ReadonlySet<string> = new Set([
  "GitHub Blog",
  "Netflix Tech Blog",
  "Stack Overflow Blog",
]);
const ENGINEERING_BLOG_BOOST = 20;

/** Bài có content snippet > N chars → boost (proxy cho bài có chiều sâu). */
const DEPTH_BOOST_MIN_CHARS = 500;
const DEPTH_BOOST = 10;

/** Hacker News là trend signal, KHÔNG được lấn slot bài chính thức. */
const HN_PENALTY = 25;

// ────────────────────────────────────────────────────────────────────────────

export type ScoreBreakdown = {
  source: number;
  recency: number;
  keywordBoost: number;
  keywordPenalty: number;
  primaryLab: number;
  engineering: number;
  depth: number;
  hnPenalty: number;
  total: number;
};

/**
 * Tính score cho 1 article. Pure function — không side effect.
 *
 * @param now thời điểm tham chiếu để tính recency. Inject vào để test.
 */
export function scoreArticle(article: Article, now: Date = new Date()): ScoreBreakdown {
  const source = SOURCE_WEIGHT[article.sourcePriority];

  // Recency: bao nhiêu giờ tuổi
  const ageHours = Math.max(
    0,
    (now.getTime() - article.pubDate.getTime()) / (1000 * 60 * 60),
  );
  const recency = ageHours >= RECENCY_WINDOW_HOURS
    ? 0
    : Math.round(RECENCY_MAX * (1 - ageHours / RECENCY_WINDOW_HOURS));

  const kw = keywordScore(article.title, article.contentSnippet);

  const primaryLab = PRIMARY_LAB_SOURCES.has(article.source) ? PRIMARY_LAB_BOOST : 0;
  const engineering = ENGINEERING_BLOG_SOURCES.has(article.source)
    ? ENGINEERING_BLOG_BOOST
    : 0;

  const depth = article.contentSnippet.length >= DEPTH_BOOST_MIN_CHARS ? DEPTH_BOOST : 0;

  const hnPenalty = article.source === "Hacker News" ? HN_PENALTY : 0;

  const total =
    source + recency + kw.boost - kw.penalty + primaryLab + engineering + depth - hnPenalty;

  return {
    source,
    recency,
    keywordBoost: kw.boost,
    keywordPenalty: kw.penalty,
    primaryLab,
    engineering,
    depth,
    hnPenalty,
    total,
  };
}

/**
 * Format breakdown thành string ngắn để log.
 * Vd: "src=70 rec=85 kw=+20-15 lab=+30 eng=0 dep=+10 hn=0 → 200"
 */
export function formatBreakdown(b: ScoreBreakdown): string {
  return (
    `src=${b.source} rec=${b.recency} ` +
    `kw=+${b.keywordBoost}-${b.keywordPenalty} ` +
    `lab=+${b.primaryLab} eng=+${b.engineering} ` +
    `dep=+${b.depth} hn=-${b.hnPenalty} → ${b.total}`
  );
}

/**
 * Helpers for testing.
 */
export const __test = {
  SOURCE_WEIGHT,
  RECENCY_MAX,
  RECENCY_WINDOW_HOURS,
  PRIMARY_LAB_SOURCES,
  PRIMARY_LAB_BOOST,
  ENGINEERING_BLOG_SOURCES,
  ENGINEERING_BLOG_BOOST,
  DEPTH_BOOST_MIN_CHARS,
  DEPTH_BOOST,
  HN_PENALTY,
};
