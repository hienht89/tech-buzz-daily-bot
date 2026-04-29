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
 *
 * Phase 11 — Per-Domain Trust Score:
 *   Bên cạnh `source name` boost (PRIMARY_LAB, ENGINEERING) đã có, thêm tầng
 *   per-domain trust để:
 *     (a) cộng điểm bonus cho domain uy tín dù KHÔNG nằm trong RSS_SOURCES
 *         hardcode (vd link outbound trong feed aggregator),
 *     (b) phạt nặng (BLOCKED_DOMAINS) các domain SEO farm / clickbait / paywall
 *         spam — đảm bảo không bao giờ được pick dù score keyword cao.
 *   Cấu trúc table → dễ mở rộng khi gặp domain rác mới.
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
  "Stripe Blog",
  "Cloudflare Blog",
  "Vercel Blog",
]);
const ENGINEERING_BLOG_BOOST = 20;

/** Bài có content snippet > N chars → boost (proxy cho bài có chiều sâu). */
const DEPTH_BOOST_MIN_CHARS = 500;
const DEPTH_BOOST = 10;

/** Hacker News là trend signal, KHÔNG được lấn slot bài chính thức. */
const HN_PENALTY = 25;

/**
 * Per-domain trust table. Dùng được cho cả bài từ RSS_SOURCES (cộng dồn với
 * PRIMARY_LAB / ENGINEERING) và bài đến từ link outbound (vd HN comments link
 * sang openai.com). Match theo SUFFIX domain — nên `openai.com` cũng match
 * `news.openai.com`.
 *
 * Quy ước:
 *   +25 — lab AI uy tín / paper repo / company engineering top-tier
 *   +15 — báo tech tier-1 / commentary chất lượng cao
 *   +10 — engineering blog / dev outlet uy tín
 *   +5  — outlet biết mặt nhưng chưa top
 */
const DOMAIN_TRUST_TABLE: ReadonlyArray<readonly [string, number]> = [
  // AI labs
  ["openai.com", 25],
  ["anthropic.com", 25],
  ["deepmind.google", 25],
  ["deepmind.com", 25],
  ["ai.google", 25],
  ["blog.google", 20],
  ["huggingface.co", 25],
  ["meta.com", 20],
  ["ai.facebook.com", 20],
  ["ai.meta.com", 20],
  ["mistral.ai", 25],
  ["x.ai", 25],
  ["cohere.com", 20],
  ["arxiv.org", 20],
  ["paperswithcode.com", 15],
  // Báo tech tier-1
  ["techcrunch.com", 15],
  ["theverge.com", 15],
  ["wired.com", 15],
  ["arstechnica.com", 15],
  ["bbc.co.uk", 12],
  ["bbc.com", 12],
  ["nytimes.com", 12],
  ["wsj.com", 12],
  ["bloomberg.com", 12],
  ["reuters.com", 12],
  ["ft.com", 12],
  // Engineering blogs
  ["github.blog", 15],
  ["github.com", 10],
  ["stripe.com", 15],
  ["cloudflare.com", 15],
  ["vercel.com", 15],
  ["netflixtechblog.com", 15],
  ["stackoverflow.blog", 12],
  ["aws.amazon.com", 12],
  ["azure.microsoft.com", 12],
  // AI commentary uy tín
  ["simonwillison.net", 15],
  ["latent.space", 15],
  ["thezvi.substack.com", 10],
  ["interconnects.ai", 10],
];

/**
 * Domain bị block tuyệt đối — không bao giờ được post dù score cao.
 * Áp dụng cho SEO farm, content mill, deal aggregator, spam.
 * Trả về penalty rất lớn (-1000) để score xuống âm sâu, fall ra ngoài bucket.
 */
const BLOCKED_DOMAINS: ReadonlySet<string> = new Set([
  "androidauthority.com", // hay aggregate lại tin lab AI nhưng SEO-heavy
  "androidpolice.com",
  "androidcentral.com",
  "phonearena.com",
  "gsmarena.com",
  "9to5mac.com", // rumor mill
  "9to5google.com",
  "macrumors.com",
  "appleinsider.com",
  "dealnews.com",
  "slickdeals.net",
  "thedailybeast.com",
  "buzzfeed.com",
  "mashable.com", // mostly clickbait listicles
  "lifehacker.com",
  "gizmodo.com", // post-spinoff chất lượng giảm
  "tomsguide.com",
  "tomshardware.com",
  "pcmag.com", // affiliate-heavy
  "businessinsider.com", // paywall spam
]);
const BLOCKED_DOMAIN_PENALTY = 1000;

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
  /** Per-domain trust bonus (Phase 11). 0 nếu domain không có trong table. */
  domainTrust: number;
  /** Per-domain block penalty (Phase 11). >0 nếu domain bị block, ngược lại 0. */
  domainBlock: number;
  total: number;
};

/**
 * Trích domain (lowercased, không port) từ URL. Trả "" nếu URL không parse được.
 */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Lookup domain trust theo SUFFIX match (vd `news.openai.com` match `openai.com`).
 * Trả 0 nếu không match.
 */
function lookupDomainTrust(domain: string): number {
  if (!domain) return 0;
  for (const [d, score] of DOMAIN_TRUST_TABLE) {
    if (domain === d || domain.endsWith("." + d)) return score;
  }
  return 0;
}

/**
 * Check domain blocked (suffix match như trust table).
 */
function isDomainBlocked(domain: string): boolean {
  if (!domain) return false;
  for (const d of BLOCKED_DOMAINS) {
    if (domain === d || domain.endsWith("." + d)) return true;
  }
  return false;
}

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

  // Phase 11: per-domain trust + block
  const domain = extractDomain(article.canonicalUrl || article.link);
  const domainTrust = lookupDomainTrust(domain);
  const domainBlock = isDomainBlocked(domain) ? BLOCKED_DOMAIN_PENALTY : 0;

  const total =
    source + recency + kw.boost - kw.penalty + primaryLab + engineering + depth - hnPenalty +
    domainTrust - domainBlock;

  return {
    source,
    recency,
    keywordBoost: kw.boost,
    keywordPenalty: kw.penalty,
    primaryLab,
    engineering,
    depth,
    hnPenalty,
    domainTrust,
    domainBlock,
    total,
  };
}

/**
 * Format breakdown thành string ngắn để log.
 * Vd: "src=70 rec=85 kw=+20-15 lab=+30 eng=0 dep=+10 hn=0 dom=+15-0 → 215"
 */
export function formatBreakdown(b: ScoreBreakdown): string {
  return (
    `src=${b.source} rec=${b.recency} ` +
    `kw=+${b.keywordBoost}-${b.keywordPenalty} ` +
    `lab=+${b.primaryLab} eng=+${b.engineering} ` +
    `dep=+${b.depth} hn=-${b.hnPenalty} ` +
    `dom=+${b.domainTrust}-${b.domainBlock} → ${b.total}`
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
  DOMAIN_TRUST_TABLE,
  BLOCKED_DOMAINS,
  BLOCKED_DOMAIN_PENALTY,
  extractDomain,
  lookupDomainTrust,
  isDomainBlocked,
};
