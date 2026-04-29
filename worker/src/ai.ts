import type { Article } from "./rss.js";
import type { Env } from "./index.js";

const MODEL = "gemini-2.5-flash";

export type Summary = {
  title: string;
  body: string;
  takeaway: string;
};

const PROMPT = `Bạn là biên tập viên cho kênh Telegram "Tech Buzz Daily" — kênh tin tức công nghệ tiếng Việt với phong cách trẻ trung, năng động, hơi "lầy" nhưng vẫn chuẩn xác.

Hãy tóm tắt bài viết tech sau đây thành nội dung tiếng Việt theo format JSON CHÍNH XÁC:
{
  "title": "Tiêu đề ngắn gọn, hấp dẫn bằng tiếng Việt (tối đa 100 ký tự, có thể dùng emoji ở đầu)",
  "body": "2-3 câu tóm tắt nội dung chính, viết tự nhiên, có thể chèn từ tiếng Anh tự nhiên (như AI, GPT, model, startup...)",
  "takeaway": "1 câu insight/điểm nhấn thú vị, ngắn gọn — tại sao tin này quan trọng hoặc đáng chú ý"
}

QUY TẮC:
- Văn phong trẻ, conversational, không cứng nhắc kiểu báo chí
- KHÔNG dịch tên riêng (OpenAI, Google, Meta, Anthropic...)
- Có thể dùng từ tiếng Anh phổ biến (AI, model, launch, startup, demo, beta...)
- KHÔNG bịa thông tin không có trong bài
- TRẢ VỀ CHỈ JSON, không có text giải thích, không có markdown code fences

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

function tryParseSummary(rawText: string): Summary | null {
  const cleaned = stripCodeFences(rawText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  const obj = parsed as Partial<Summary>;
  if (!obj.title || !obj.body || !obj.takeaway) return null;
  return {
    title: obj.title.trim(),
    body: obj.body.trim(),
    takeaway: obj.takeaway.trim(),
  };
}

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
