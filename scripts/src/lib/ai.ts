import { GoogleGenAI } from "@google/genai";
import type { Article } from "./rss.js";

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) {
  throw new Error("Missing GOOGLE_API_KEY environment variable");
}

const ai = new GoogleGenAI({ apiKey });
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

function isRetryableError(err: unknown): boolean {
  const e = err as { status?: number; message?: string };
  if (e.status === 503 || e.status === 429 || e.status === 500 || e.status === 502 || e.status === 504) {
    return true;
  }
  const msg = e.message?.toLowerCase() ?? "";
  return msg.includes("unavailable") || msg.includes("overloaded") || msg.includes("rate");
}

async function callGemini(article: Article): Promise<string> {
  const maxRetries = 4;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: MODEL,
        contents: [{ role: "user", parts: [{ text: buildPrompt(article) }] }],
        config: {
          responseMimeType: "application/json",
          maxOutputTokens: 8192,
          temperature: 0.7,
        },
      });
      const text = response.text;
      if (!text) throw new Error("Gemini returned empty response");
      return text;
    } catch (err) {
      lastErr = err;
      if (!isRetryableError(err) || attempt === maxRetries - 1) throw err;
      const backoffMs = 2000 * Math.pow(2, attempt);
      console.warn(
        `[ai] Gemini error (attempt ${attempt + 1}/${maxRetries}), retrying in ${backoffMs}ms: ${(err as Error).message?.slice(0, 200)}`,
      );
      await sleep(backoffMs);
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

export async function summarizeArticle(article: Article): Promise<Summary> {
  const maxParseRetries = 3;
  let lastRaw = "";
  for (let attempt = 0; attempt < maxParseRetries; attempt++) {
    const raw = await callGemini(article);
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
