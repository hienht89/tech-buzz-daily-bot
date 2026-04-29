/**
 * Multi-layer dedup.
 *
 * LAYER 1 (exact, KV-backed):
 *   - canonical URL hash (đã có sẵn `posted:*` trong storage.ts)
 *   - normalized title hash (`title:*` mới — bài cùng title từ URL khác vẫn dedupe)
 *
 * LAYER 2 (fuzzy, KV-backed):
 *   - load 200 normalized title gần nhất từ KV
 *   - tính trigram Jaccard similarity vs candidate
 *   - threshold ≥ FUZZY_THRESHOLD (0.88) → coi là trùng
 *
 * LAYER 3 (event-clustering, in-memory):
 *   - chạy trên batch cùng lúc (sau fetch + filter)
 *   - cluster bài có title similarity ≥ EVENT_THRESHOLD (0.80) lại
 *   - giữ winner = sourcePriority THẤP HƠN (1 < 2 < 3) → bài source gốc thắng
 *     báo tổng hợp khi cùng sự kiện (vd: OpenAI Blog thắng TechCrunch)
 *   - tie-break: score cao hơn, content dài hơn, fresh hơn
 *
 * Pure functions — không I/O. KV interaction wrap trong storage.ts.
 */

import type { Article } from "./rss.js";

// ────────────────────────────────────────────────────────────────────────────
// Tunables
// ────────────────────────────────────────────────────────────────────────────

/** Threshold cho fuzzy dedup vs lịch sử bài đã đăng. */
export const FUZZY_THRESHOLD = 0.88;

/** Threshold cho event-clustering trong cùng batch (nhẹ hơn fuzzy vì cùng batch
 * thường có wording khá giống nhau). */
export const EVENT_THRESHOLD = 0.80;

/** Số lượng title gần nhất giữ trong KV cho fuzzy compare. */
export const RECENT_TITLES_CAP = 200;

// Stop words tiếng Anh phổ biến — drop để jaccard không bị lệch bởi từ filler
const STOP_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has",
  "have", "he", "in", "is", "it", "its", "of", "on", "that", "the", "to",
  "was", "were", "will", "with", "this", "these", "those", "but", "or",
  "not", "no", "can", "could", "should", "would", "may", "might", "must",
  "do", "does", "did", "i", "you", "we", "they", "them", "their",
]);

// ────────────────────────────────────────────────────────────────────────────
// Normalization
// ────────────────────────────────────────────────────────────────────────────

/**
 * Normalize title cho dedup:
 *   - lowercase
 *   - bỏ punctuation (giữ chữ + số + space)
 *   - bỏ stop word
 *   - collapse whitespace
 *
 * Vd: "OpenAI's GPT-5 launches!" → "openai gpt5 launches"
 *
 * Lưu ý: KHÔNG strip number vì version (gpt5, o3) là phần signal mạnh.
 */
export function normalizeTitle(title: string): string {
  const lowered = title.toLowerCase();
  // bỏ ký tự không phải chữ/số/space
  const stripped = lowered
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // bỏ diacritic
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return "";
  const tokens = stripped.split(" ").filter((t) => t && !STOP_WORDS.has(t));
  return tokens.join(" ");
}

/**
 * SHA-1 hash hex của normalized title. Dùng làm KV key cho exact dedup.
 * Cloudflare Workers có crypto.subtle native.
 */
export async function titleHash(normalizedTitle: string): Promise<string> {
  const buf = new TextEncoder().encode(normalizedTitle);
  const hash = await crypto.subtle.digest("SHA-1", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ────────────────────────────────────────────────────────────────────────────
// Trigram + Jaccard (cho fuzzy + event clustering)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Trả set 3-character shingles của text. Padding bằng space để bắt boundary.
 * Vd: "abcd" → {" ab", "abc", "bcd", "cd "}
 *
 * Set bằng Map<string, true> (Cloudflare Workers Set hỗ trợ tốt).
 */
export function trigrams(text: string): Set<string> {
  const padded = ` ${text} `;
  const out = new Set<string>();
  if (padded.length < 3) return out;
  for (let i = 0; i <= padded.length - 3; i++) {
    out.add(padded.slice(i, i + 3));
  }
  return out;
}

/**
 * Jaccard similarity = |A ∩ B| / |A ∪ B|. Range [0,1].
 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const x of a) {
    if (b.has(x)) intersect++;
  }
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

// ────────────────────────────────────────────────────────────────────────────
// Layer 2 — fuzzy dedup vs recent posted
// ────────────────────────────────────────────────────────────────────────────

export type RecentTitleEntry = {
  /** normalized title (đã qua normalizeTitle). */
  norm: string;
  /** raw title gốc (để log "trùng với bài X"). */
  raw: string;
  /** ISO timestamp khi post. */
  postedAt: string;
};

export type FuzzyDedupResult =
  | { duplicate: false }
  | { duplicate: true; similarTo: string; similarity: number };

/**
 * Check candidate có fuzzy-trùng với bài nào trong recentTitles không.
 * Return early ngay khi tìm thấy match đầu tiên ≥ threshold.
 */
export function checkFuzzyDuplicate(
  candidateTitle: string,
  recentTitles: readonly RecentTitleEntry[],
  threshold = FUZZY_THRESHOLD,
): FuzzyDedupResult {
  const candNorm = normalizeTitle(candidateTitle);
  if (!candNorm) return { duplicate: false };
  const candTri = trigrams(candNorm);
  if (candTri.size === 0) return { duplicate: false };

  for (const rt of recentTitles) {
    const sim = jaccard(candTri, trigrams(rt.norm));
    if (sim >= threshold) {
      return { duplicate: true, similarTo: rt.raw, similarity: sim };
    }
  }
  return { duplicate: false };
}

// ────────────────────────────────────────────────────────────────────────────
// Layer 3 — event clustering (intra-batch)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Compare 2 article cho event-clustering tie-break.
 * Trả article được PHẢI GIỮ (winner). Loser bị drop.
 *
 * Quy tắc theo thứ tự:
 *   1. sourcePriority THẤP hơn thắng (1 < 2 < 3) — source gốc thắng aggregator
 *   2. score cao hơn thắng (nếu chưa scored, coi là 0)
 *   3. content snippet dài hơn thắng (proxy cho bài sâu hơn)
 *   4. pubDate mới hơn thắng
 *   5. else giữ a
 */
function pickWinner(a: Article, b: Article): Article {
  if (a.sourcePriority !== b.sourcePriority) {
    return a.sourcePriority < b.sourcePriority ? a : b;
  }
  const sa = a.score ?? 0;
  const sb = b.score ?? 0;
  if (sa !== sb) return sa > sb ? a : b;
  if (a.contentSnippet.length !== b.contentSnippet.length) {
    return a.contentSnippet.length > b.contentSnippet.length ? a : b;
  }
  if (a.pubDate.getTime() !== b.pubDate.getTime()) {
    return a.pubDate.getTime() > b.pubDate.getTime() ? a : b;
  }
  return a;
}

/**
 * Cluster bài trong batch theo title similarity. Mỗi cluster giữ duy nhất 1
 * winner. Trả lại array winners (giảm số lượng candidate).
 *
 * Thuật toán: greedy — duyệt từng article, nếu match cluster nào thì so sánh
 * winner; không match thì tạo cluster mới. O(N²) nhưng N ≤ 200 → OK.
 *
 * KHÔNG mutate input.
 */
export function clusterBatch(
  articles: readonly Article[],
  threshold = EVENT_THRESHOLD,
): Article[] {
  type Cluster = { winner: Article; tris: Set<string> };
  const clusters: Cluster[] = [];

  for (const art of articles) {
    const norm = normalizeTitle(art.title);
    if (!norm) {
      // bài không có title hợp lệ → bỏ qua hoàn toàn
      continue;
    }
    const tri = trigrams(norm);

    let merged = false;
    for (const c of clusters) {
      const sim = jaccard(tri, c.tris);
      if (sim >= threshold) {
        const newWinner = pickWinner(c.winner, art);
        if (newWinner !== c.winner) {
          c.winner = newWinner;
          // recompute tris cho cluster theo title của winner mới
          c.tris = trigrams(normalizeTitle(newWinner.title));
        }
        merged = true;
        break;
      }
    }
    if (!merged) {
      clusters.push({ winner: art, tris: tri });
    }
  }

  return clusters.map((c) => c.winner);
}

/**
 * Helpers for testing.
 */
export const __test = {
  STOP_WORDS,
};
