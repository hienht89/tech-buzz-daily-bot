/**
 * Keyword-based scoring + arxiv stricter filter.
 *
 * Triết lý:
 * - PENALTY → bài chất lượng thấp / spam-y (review, leak, sponsored…)
 * - BOOST   → bài có signal mạnh về tech thực sự đáng đăng (release, model,
 *             security, vendor name lớn…)
 * - arxiv stricter: arxiv RSS đẩy paper khá ngẫu nhiên, nhiều paper khái niệm
 *   khô khan (vd "Stochastic Gradient on Riemannian Manifolds with Bayesian…").
 *   Lọc về paper có keyword AI thực tế đáng đọc.
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
// ────────────────────────────────────────────────────────────────────────────
const BOOST_KEYWORDS: readonly string[] = [
  // Product / launch
  "release",
  "released",
  "releases",
  "launch",
  "launches",
  "announce",
  "announces",
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
  "open source",
  "open-source",
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
// ARXIV STRICT: arxiv RSS spam paper khái niệm thuần túy. Yêu cầu title chứa
// ít nhất 1 keyword AI/ML có giá trị thực tế.
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

/**
 * Đếm số penalty hit + boost hit trong title + snippet.
 * Trả về object cho scoring engine.
 *
 * Cap tránh 1 bài được boost / penalty quá đà (vd title có 5 boost keyword
 * không nên hơn bài có 3 boost keyword chất lượng).
 */
export function keywordScore(
  title: string,
  snippet: string,
): { boost: number; penalty: number } {
  const text = `${title} ${snippet}`.toLowerCase();

  let penaltyHits = 0;
  for (const kw of PENALTY_KEYWORDS) {
    if (text.includes(kw)) penaltyHits++;
  }

  let boostHits = 0;
  for (const kw of BOOST_KEYWORDS) {
    if (text.includes(kw)) boostHits++;
  }

  return {
    boost: Math.min(boostHits * BOOST_PER_HIT, BOOST_CAP),
    penalty: Math.min(penaltyHits * PENALTY_PER_HIT, PENALTY_CAP),
  };
}

/**
 * Stricter filter cho arxiv: drop bài không có signal AI thực tế trong title.
 * Áp dụng KHI source.name === "arXiv cs.AI".
 *
 * Trả true nếu bài đáng giữ.
 */
export function isRelevantArxivPaper(title: string): boolean {
  const lower = title.toLowerCase();
  for (const kw of ARXIV_REQUIRED_KEYWORDS) {
    if (lower.includes(kw)) return true;
  }
  return false;
}

/**
 * Helpers for testing / debugging only.
 */
export const __test = {
  PENALTY_KEYWORDS,
  BOOST_KEYWORDS,
  PENALTY_PER_HIT,
  BOOST_PER_HIT,
  PENALTY_CAP,
  BOOST_CAP,
  ARXIV_REQUIRED_KEYWORDS,
};
