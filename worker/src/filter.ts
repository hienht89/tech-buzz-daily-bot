/**
 * Keyword-based scoring + arxiv stricter filter.
 *
 * Triết lý:
 * - PENALTY → bài chất lượng thấp / spam-y (review, leak, sponsored…)
 * - BOOST   → bài có signal mạnh về tech thực sự đáng đăng (release, model,
 *             security, vendor name lớn…)
 * - NEWS_VERB → động từ NEWS thực sự (launches, released, raises, acquires…)
 *               cộng nhiều hơn BOOST để ưu tiên tin "có sự kiện" thay vì
 *               tutorial / explainer chỉ chứa từ tech.
 * - FLUFF   → tín hiệu PR/anniversary/tutorial sơ cấp (celebrating, anniversary,
 *             "X years", "for beginners", "what is"…) — bị penalty riêng để
 *             scoring engine deprioritize.
 * - arxiv stricter: arxiv RSS đẩy paper khá ngẫu nhiên, nhiều paper khái niệm
 *   khô khan (vd "Stochastic Gradient on Riemannian Manifolds with Bayesian…").
 *   Yêu cầu ≥2 keyword AI/LLM khớp (non-overlap) để giảm false positive như
 *   "SoccerRef-Agents" (chỉ match "agent").
 *
 * Tất cả config ở top file để dễ chỉnh. Các hàm trả về số nguyên, scoring engine
 * trong score.ts sẽ tổng hợp với weight khác.
 */

// ────────────────────────────────────────────────────────────────────────────
// PENALTY: bài có 1 trong các keyword này KHÔNG bị reject ngay (vì nhiều khi
// vẫn có giá trị) — bị penalty score, scoring engine sẽ tự deprioritize.
// ────────────────────────────────────────────────────────────────────────────
const PENALTY_KEYWORDS: readonly string[] = [
  // Review / opinion / non-news
  "review",
  "hands-on",
  "hands on",
  "opinion",
  "editorial",
  "first look",
  // Rumor / leak (chưa xác thực)
  "rumor",
  "rumors",
  "rumour",
  "leak",
  "leaked",
  "leaks",
  // Commerce / deals
  "deal",
  "deals",
  "sale",
  " buy ",
  "discount",
  "best price",
  "accessory",
  "accessories",
  "gift guide",
  // Sponsored
  "sponsored",
  "promoted",
  "paid post",
] as const;

const PENALTY_PER_HIT = 15;
const PENALTY_CAP = 40;

// ────────────────────────────────────────────────────────────────────────────
// BOOST: keyword đặc trưng cho bài tech "thật" có signal cao.
// LƯU Ý: các động từ NEWS chuyển sang NEWS_VERB_KEYWORDS để cộng mạnh hơn.
// ────────────────────────────────────────────────────────────────────────────
const BOOST_KEYWORDS: readonly string[] = [
  // Product / launch (giữ noun forms / tense yếu hơn ở đây; verb forms ở NEWS_VERB)
  "unveil",
  "unveils",
  "introduce",
  "introduces",
  "rollout",
  "rolls out",
  // AI / ML technical
  "benchmark",
  "model",
  "reasoning",
  "agent",
  "agentic",
  "inference",
  "training",
  "fine-tune",
  "fine-tuning",
  "multimodal",
  "embedding",
  "transformer",
  "diffusion",
  // Hardware / infra
  "chips",
  "gpu",
  "tpu",
  "datacenter",
  "data center",
  // Vendor names — boost AI labs
  "openai",
  "anthropic",
  "deepmind",
  "nvidia",
  "google deepmind",
  "meta ai",
  "hugging face",
  "mistral",
  "stability ai",
  // Security / outage
  "security",
  "vulnerability",
  "vulnerabilities",
  "cve-",
  "zero-day",
  "exploit",
  "outage",
  "breach",
  "data breach",
  // Engineering
  "github",
  "kubernetes",
  "postgres",
  "rust",
  "typescript",
] as const;

const BOOST_PER_HIT = 10;
const BOOST_CAP = 30;

// ────────────────────────────────────────────────────────────────────────────
// NEWS VERBS: tín hiệu "có sự kiện" mạnh nhất — release/launch/raise/acquire/
// partnership/GA/open source. Cộng nhiều hơn BOOST để bài news vượt qua bài
// tutorial/explainer chỉ chứa từ tech generic. Cap riêng để 1 title spam
// nhiều verb không lệch quá đà.
// ────────────────────────────────────────────────────────────────────────────
const NEWS_VERB_KEYWORDS: readonly string[] = [
  "launches",
  "launched",
  "released",
  "releases",
  "announces",
  "announced",
  "raises",
  "raised",
  "acquires",
  "acquired",
  "acquisition",
  "partners with",
  "open source",
  "open-source",
  "open sources",
  "open-sources",
  "generally available",
  "general availability",
] as const;

const NEWS_VERB_PER_HIT = 20;
const NEWS_VERB_CAP = 40;

// ────────────────────────────────────────────────────────────────────────────
// FLUFF: PR/anniversary/tutorial sơ cấp — tín hiệu bài KHÔNG phải news, dù
// score keyword/source/recency cao. Penalty riêng để scoring engine kéo xuống
// dưới slot top channel.
// ────────────────────────────────────────────────────────────────────────────
const FLUFF_KEYWORDS: readonly string[] = [
  "celebrating",
  "anniversary",
  "years of",
  "fun facts",
  "fun fact",
  "tips and tricks",
  "tips & tricks",
  "for beginners",
  "getting started",
  "what is",
  "a beginner",
  "beginner's guide",
  "beginners guide",
  "introduction to",
] as const;

/** Bắt mẫu "20 years", "5 year" — anniversary-style title không có "years of". */
const FLUFF_REGEX = /\b\d+\s+years?\b/i;

const FLUFF_PER_HIT = 15;
const FLUFF_CAP = 30;

// ────────────────────────────────────────────────────────────────────────────
// ARXIV STRICT: arxiv RSS spam paper khái niệm thuần túy. Yêu cầu title chứa
// ÍT NHẤT 2 keyword AI/ML khác nhau (non-overlapping) để có giá trị thực tế.
// Phase trước chỉ yêu cầu ≥1 → false positive nhiều (vd "SoccerRef-Agents:
// Multi-Agent Soccer Refereeing" match mỗi "agent" và lọt top channel).
// ────────────────────────────────────────────────────────────────────────────
const ARXIV_REQUIRED_KEYWORDS: readonly string[] = [
  "llm",
  "large language model",
  "language model",
  "agent",
  "agentic",
  "rag ",
  "retrieval-augmented",
  "retrieval augmented",
  "reasoning",
  "multimodal",
  "vision",
  "alignment",
  "safety",
  "benchmark",
  "transformer",
  "diffusion",
  "fine-tun",
  "fine tun",
  "instruction tun",
  "rlhf",
  "rlaif",
  "code generation",
  "robotics",
  "embodied",
  "world model",
  "video generation",
  "image generation",
  "speech",
  "tts",
  "asr",
  "moe",
  "mixture of experts",
  "long context",
  "context window",
  "token",
  "evaluation",
  "eval",
  "gpt",
  "claude",
  "gemini",
  "llama",
  "mistral",
  "qwen",
] as const;

const ARXIV_MIN_DISTINCT_HITS = 2;

export type KeywordScoreResult = {
  /** Generic boost từ BOOST_KEYWORDS (vendor/tech terms). */
  boost: number;
  /** Generic penalty từ PENALTY_KEYWORDS (review/leak/deal/sponsored). */
  penalty: number;
  /** News verb boost — tín hiệu "có sự kiện" (launches/raises/acquires…). */
  newsVerbBoost: number;
  /** Fluff penalty — anniversary/tutorial sơ cấp. */
  fluffPenalty: number;
};

/**
 * Đếm số penalty hit + boost hit + news verb hit + fluff hit trong title + snippet.
 * Trả về object cho scoring engine.
 *
 * Cap tránh 1 bài được boost / penalty quá đà (vd title có 5 boost keyword
 * không nên hơn bài có 3 boost keyword chất lượng).
 */
export function keywordScore(
  title: string,
  snippet: string,
): KeywordScoreResult {
  const text = `${title} ${snippet}`.toLowerCase();

  let penaltyHits = 0;
  for (const kw of PENALTY_KEYWORDS) {
    if (text.includes(kw)) penaltyHits++;
  }

  let boostHits = 0;
  for (const kw of BOOST_KEYWORDS) {
    if (text.includes(kw)) boostHits++;
  }

  let newsVerbHits = 0;
  for (const kw of NEWS_VERB_KEYWORDS) {
    if (text.includes(kw)) newsVerbHits++;
  }

  let fluffHits = 0;
  for (const kw of FLUFF_KEYWORDS) {
    if (text.includes(kw)) fluffHits++;
  }
  if (FLUFF_REGEX.test(text)) fluffHits++;

  return {
    boost: Math.min(boostHits * BOOST_PER_HIT, BOOST_CAP),
    penalty: Math.min(penaltyHits * PENALTY_PER_HIT, PENALTY_CAP),
    newsVerbBoost: Math.min(newsVerbHits * NEWS_VERB_PER_HIT, NEWS_VERB_CAP),
    fluffPenalty: Math.min(fluffHits * FLUFF_PER_HIT, FLUFF_CAP),
  };
}

/**
 * Stricter filter cho arxiv: drop bài không có ≥2 keyword AI/ML khác nhau
 * (non-overlapping) trong title. Áp dụng KHI source.name === "arXiv cs.AI".
 *
 * Non-overlap quan trọng vì keyword list có nested entries
 * ("large language model" chứa "language model"). Đếm overlap → 1 phrase
 * thành 2 hits ảo.
 *
 * Trả true nếu bài đáng giữ.
 */
export function isRelevantArxivPaper(title: string): boolean {
  const lower = title.toLowerCase();
  const matchedRanges: Array<[number, number]> = [];
  let distinctHits = 0;
  for (const kw of ARXIV_REQUIRED_KEYWORDS) {
    const idx = lower.indexOf(kw);
    if (idx === -1) continue;
    const range: [number, number] = [idx, idx + kw.length];
    // Skip nếu overlap với 1 match đã đếm — tránh double count nested keyword.
    const overlaps = matchedRanges.some(
      ([s, e]) => !(range[1] <= s || range[0] >= e),
    );
    if (overlaps) continue;
    matchedRanges.push(range);
    distinctHits++;
    if (distinctHits >= ARXIV_MIN_DISTINCT_HITS) return true;
  }
  return false;
}

/**
 * Helpers for testing / debugging only.
 */
export const __test = {
  PENALTY_KEYWORDS,
  BOOST_KEYWORDS,
  NEWS_VERB_KEYWORDS,
  FLUFF_KEYWORDS,
  PENALTY_PER_HIT,
  BOOST_PER_HIT,
  NEWS_VERB_PER_HIT,
  FLUFF_PER_HIT,
  PENALTY_CAP,
  BOOST_CAP,
  NEWS_VERB_CAP,
  FLUFF_CAP,
  ARXIV_REQUIRED_KEYWORDS,
  ARXIV_MIN_DISTINCT_HITS,
};
