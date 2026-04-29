import type { Article } from "./rss.js";
import type { Env } from "./index.js";

const MODEL = "gemini-2.5-flash";

/**
 * Summary mới (v2):
 *   - title: Tiêu đề tiếng Việt + emoji prefix
 *   - bullets: 2-3 bullet ngắn gọn, mỗi bullet 1 fact key
 *   - whyItMatters: 1 câu "Vì sao đáng đọc" — insight cho người đọc Gen Z
 *
 * Backward compat: legacy { title, body, takeaway } vẫn parse được — convert
 * tự động sang format mới ở `tryParseSummary`.
 */
export type Summary = {
  title: string;
  bullets: string[];
  whyItMatters: string;
};

const PROMPT = `Bạn là biên tập viên cho kênh Telegram "Tech Buzz Daily" — kênh tin tức công nghệ tiếng Việt cho dân tech, tone Gen Z: trẻ, năng động, hơi "lầy" nhưng chuẩn xác.

Hãy tóm tắt bài viết tech sau đây thành tiếng Việt theo format JSON CHÍNH XÁC:
{
  "title": "Tiêu đề tiếng Việt ngắn gọn, hấp dẫn (tối đa 90 ký tự). BẮT BUỘC bắt đầu bằng 1 emoji phù hợp (vd: 🚀 🤖 🧠 🛠️ 🔥 🎯 🪄 🧪 🛡️ 📱 💸).",
  "bullets": ["2-3 bullet, mỗi bullet 1 câu ngắn gọn (≤120 ký tự), tóm tắt fact chính. KHÔNG mở đầu bằng dấu chấm, gạch ngang hay emoji — sẽ được render thành '• ...' tự động."],
  "whyItMatters": "1 câu duy nhất (≤200 ký tự) trả lời 'Vì sao đáng đọc?' — nêu impact/insight cho dân tech Việt, không lặp lại bullet."
}

QUY TẮC:
- Văn phong trẻ, conversational, KHÔNG cứng nhắc kiểu báo chí.
- KHÔNG dịch tên riêng (OpenAI, Google, Meta, Anthropic, Hugging Face...).
- Có thể dùng từ tiếng Anh phổ biến (AI, model, launch, startup, demo, beta, agent, benchmark, fine-tune...).
- Bullet phải có nội dung CỤ THỂ từ bài (số liệu, tên model, ngày, tên người), KHÔNG nói chung chung.
- KHÔNG bịa thông tin ngoài bài. Nếu bài quá ngắn, làm 2 bullet thay vì 3.
- "whyItMatters" phải là góc nhìn / hệ quả, KHÔNG được lặp y nguyên 1 bullet.
- TRẢ VỀ CHỈ JSON hợp lệ, KHÔNG markdown code fence, KHÔNG text giải thích.

Bài viết:
Tiêu đề gốc: {{TITLE}}
Nguồn: {{SOURCE}}
Nội dung: {{CONTENT}}`;

function buildPrompt(article: Article): string {
  const content = article.contentSnippet.slice(0, 3000);
  return PROMPT.replace("{{TITLE}}", article.title)
    .replace("{{SOURCE}}", article.source)
    .replace("{{CONTENT}}", content || article.title);
}

function stripCodeFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type GeminiHttpError = Error & { status?: number };

const GEMINI_TIMEOUT_MS = 20_000;

async function callGemini(article: Article, apiKey: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;
  const reqBody = {
    contents: [{ role: "user", parts: [{ text: buildPrompt(article) }] }],
    generationConfig: {
      responseMimeType: "application/json",
      maxOutputTokens: 8192,
      temperature: 0.7,
    },
  };

  const maxRetries = 4;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        const err = new Error(
          `Gemini HTTP ${res.status}: ${errText.slice(0, 300)}`,
        ) as GeminiHttpError;
        err.status = res.status;
        throw err;
      }
      const data = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error("Gemini returned empty response");
      return text;
    } catch (err) {
      lastErr = err;
      const isAbort = (err as Error).name === "AbortError";
      if (isAbort) {
        const wrapped = new Error(`Gemini timeout after ${GEMINI_TIMEOUT_MS}ms`) as GeminiHttpError;
        wrapped.status = 408;
        lastErr = wrapped;
      }
      const status = (lastErr as GeminiHttpError).status;
      const msg = (lastErr as Error).message?.toLowerCase() ?? "";
      const retryable =
        isAbort ||
        status === 429 ||
        status === 500 ||
        status === 502 ||
        status === 503 ||
        status === 504 ||
        msg.includes("unavailable") ||
        msg.includes("overloaded") ||
        msg.includes("rate") ||
        msg.includes("fetch");
      if (!retryable || attempt === maxRetries - 1) throw lastErr;
      const backoffMs = 2000 * Math.pow(2, attempt);
      console.warn(
        `[ai] Gemini retry ${attempt + 1}/${maxRetries} in ${backoffMs}ms: ${(lastErr as Error).message?.slice(0, 200)}`,
      );
      await sleep(backoffMs);
    } finally {
      clearTimeout(timeoutId);
    }
  }
  throw lastErr;
}

/**
 * Parse JSON từ Gemini. Hỗ trợ:
 *   - Schema mới: { title, bullets[], whyItMatters }
 *   - Schema cũ:  { title, body, takeaway } → convert sang bullets từ body
 *     (split theo câu, lấy 2-3 câu)
 *
 * Sanitize bullets: bỏ marker đầu ('-', '•', '*', '·', '–', '—'), trim.
 */
function tryParseSummary(rawText: string): Summary | null {
  const cleaned = stripCodeFences(rawText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  const title = typeof obj.title === "string" ? obj.title.trim() : "";
  if (!title) return null;

  // Schema mới
  if (Array.isArray(obj.bullets) && typeof obj.whyItMatters === "string") {
    const bullets = sanitizeBullets(obj.bullets);
    const why = obj.whyItMatters.trim();
    if (bullets.length === 0 || !why) return null;
    return { title, bullets, whyItMatters: why };
  }

  // Schema cũ — fallback graceful
  if (typeof obj.body === "string" && typeof obj.takeaway === "string") {
    const sentences = obj.body
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const bullets = sanitizeBullets(sentences.slice(0, 3));
    const why = obj.takeaway.trim();
    if (bullets.length === 0 || !why) return null;
    return { title, bullets, whyItMatters: why };
  }

  return null;
}

const BULLET_MARKER_REGEX = /^[\s\-•*·–—]+/;
const MAX_BULLETS = 3;
const MAX_BULLET_CHARS = 220;

function sanitizeBullets(raw: unknown[]): string[] {
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const cleaned = item.replace(BULLET_MARKER_REGEX, "").trim();
    if (!cleaned) continue;
    out.push(cleaned.length > MAX_BULLET_CHARS ? cleaned.slice(0, MAX_BULLET_CHARS - 1) + "…" : cleaned);
    if (out.length >= MAX_BULLETS) break;
  }
  return out;
}

/**
 * Helpers for testing.
 */
export const __test = {
  tryParseSummary,
  sanitizeBullets,
};

export async function summarizeArticle(article: Article, env: Env): Promise<Summary> {
  const maxParseRetries = 3;
  let lastRaw = "";
  for (let attempt = 0; attempt < maxParseRetries; attempt++) {
    const raw = await callGemini(article, env.GOOGLE_API_KEY);
    lastRaw = raw;
    const summary = tryParseSummary(raw);
    if (summary) return summary;
    console.warn(
      `[ai] Failed to parse Gemini JSON (attempt ${attempt + 1}/${maxParseRetries}). Regenerating...`,
    );
    await sleep(1000);
  }
  throw new Error(
    `Gemini returned unparseable/incomplete JSON after ${maxParseRetries} attempts. Last raw: ${lastRaw.slice(0, 500)}`,
  );
}
