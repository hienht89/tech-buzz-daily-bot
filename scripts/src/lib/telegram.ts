import type { Article } from "./rss.js";
import type { Summary } from "./ai.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHANNEL_ID;
const SIGNATURE_NAME = process.env.TELEGRAM_SIGNATURE ?? "Tech Buzz Daily";
const SIGNATURE_EMOJI = process.env.TELEGRAM_SIGNATURE_EMOJI ?? "🐝";

if (!TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN environment variable");
if (!CHAT_ID) throw new Error("Missing TELEGRAM_CHANNEL_ID environment variable");

const API = `https://api.telegram.org/bot${TOKEN}`;

const CHANNEL_HANDLE = CHAT_ID.startsWith("@") ? CHAT_ID.slice(1) : null;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

function buildSignatureLine(): string {
  const brand = `${SIGNATURE_EMOJI} <b>${escapeHtml(SIGNATURE_NAME)}</b>`;
  if (!CHANNEL_HANDLE) return `— ${brand}`;
  const handleLink = `<a href="https://t.me/${escapeHtmlAttr(CHANNEL_HANDLE)}">@${escapeHtml(CHANNEL_HANDLE)}</a>`;
  return `— ${brand} · ${handleLink}`;
}

function formatCaption(article: Article, summary: Summary): string {
  const title = escapeHtml(summary.title);
  const body = escapeHtml(summary.body);
  const takeaway = escapeHtml(summary.takeaway);
  const source = escapeHtml(article.source);
  const link = escapeHtmlAttr(article.link);

  return [
    `<b>${title}</b>`,
    "",
    body,
    "",
    `💡 ${takeaway}`,
    "",
    `🔗 <a href="${link}">${source}</a>`,
    "",
    buildSignatureLine(),
  ].join("\n");
}

type TelegramResponse = {
  ok: boolean;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
  result?: unknown;
};

class TelegramError extends Error {
  status: number;
  retryAfter?: number;
  description?: string;
  constructor(message: string, status: number, retryAfter?: number, description?: string) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
    this.description = description;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rawCall(
  method: string,
  body: Record<string, unknown>,
): Promise<TelegramResponse> {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: TelegramResponse;
  try {
    data = (await res.json()) as TelegramResponse;
  } catch {
    throw new TelegramError(
      `Telegram ${method} returned non-JSON (status ${res.status})`,
      res.status,
    );
  }
  if (!data.ok) {
    throw new TelegramError(
      `Telegram ${method} failed: ${data.description ?? res.statusText}`,
      res.status,
      data.parameters?.retry_after,
      data.description,
    );
  }
  return data;
}

/**
 * Chỉ fallback sendPhoto → sendMessage khi CHẮC CHẮN không có ảnh nào được
 * gửi tới channel (tránh dupe). Mirror policy của worker/src/telegram.ts.
 */
function isSafeToFallbackFromSendPhoto(err: unknown): boolean {
  if (!(err instanceof TelegramError)) return false;
  if (err.status !== 400) return false;
  const desc = (err.description ?? "").toLowerCase();
  if (!desc) return false;
  const photoIssuePatterns = [
    "wrong file identifier",
    "wrong remote file identifier",
    "wrong remote photo url",
    "webpage_curl_failed",
    "photo_invalid_dimensions",
    "image_process_failed",
    "wrong type of the web page content",
    "failed to get http url content",
    "wrong url",
    "wrong url host",
    "url host is empty",
    "photo url",
    "media_invalid",
    "file is too big",
    "file_part_invalid",
    "wrong padding in the string",
    "caption is too long",
  ];
  return photoIssuePatterns.some((p) => desc.includes(p));
}

function isRetryableTelegramError(err: unknown): boolean {
  if (err instanceof TelegramError) {
    if (err.status === 429) return true;
    if (err.status >= 500 && err.status < 600) return true;
    return false;
  }
  // Network / fetch errors (TypeError from undici) are retryable
  return err instanceof Error && (err.name === "TypeError" || err.message.includes("fetch"));
}

async function callApiWithRetry(
  method: string,
  body: Record<string, unknown>,
  maxRetries = 4,
): Promise<TelegramResponse> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await rawCall(method, body);
    } catch (err) {
      lastErr = err;
      if (!isRetryableTelegramError(err) || attempt === maxRetries - 1) throw err;
      let waitMs: number;
      if (err instanceof TelegramError && err.retryAfter) {
        waitMs = (err.retryAfter + 1) * 1000;
      } else {
        waitMs = 2000 * Math.pow(2, attempt) + Math.floor(Math.random() * 1000);
      }
      console.warn(
        `[telegram] ${method} error (attempt ${attempt + 1}/${maxRetries}), retrying in ${waitMs}ms: ${(err as Error).message?.slice(0, 200)}`,
      );
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

const MAX_CAPTION_LEN = 1024;
const MAX_MESSAGE_LEN = 4096;

/**
 * Cắt CHUỖI ĐÃ ESCAPE HTML cho vừa độ dài Telegram, nhưng:
 *  - KHÔNG cắt giữa entity (vd `&amp;` → `&am`) → invalid HTML → Telegram reject
 *  - KHÔNG cắt giữa thẻ (vd `<a href="...` chưa close) → invalid HTML
 *
 * Cách làm: nếu vị trí cắt rơi vào trong entity hoặc trong tag, lùi về trước
 * dấu `&` hoặc `<` gần nhất.
 */
export function safeTrimEscaped(escaped: string, max: number): string {
  if (escaped.length <= max) return escaped;
  let cut = max - 3; // chừa 3 ký tự cho "..."
  if (cut <= 0) return escaped.slice(0, max);

  const head = escaped.slice(0, cut);

  // Nếu đang trong 1 entity (& chưa được đóng bằng ;), lùi về trước &
  const lastAmp = head.lastIndexOf("&");
  const lastSemi = head.lastIndexOf(";");
  if (lastAmp > lastSemi) cut = lastAmp;

  // Nếu đang trong 1 thẻ (< chưa được đóng bằng >), lùi về trước <
  const head2 = escaped.slice(0, cut);
  const lastLt = head2.lastIndexOf("<");
  const lastGt = head2.lastIndexOf(">");
  if (lastLt > lastGt) cut = lastLt;

  if (cut <= 0) return "...";
  return escaped.slice(0, cut) + "...";
}

async function sendTextMessage(article: Article, caption: string): Promise<void> {
  await callApiWithRetry("sendMessage", {
    chat_id: CHAT_ID,
    text: safeTrimEscaped(caption, MAX_MESSAGE_LEN),
    parse_mode: "HTML",
    // TẮT HẲN web preview của Telegram. Caption đã có title VN + nguồn + link.
    // Nếu để Telegram tự fetch link → preview hiện title + description tiếng
    // Anh gốc PHÍA TRÊN text Việt → trông như 2 bài chồng nhau.
    link_preview_options: { is_disabled: true },
  });
}

export async function postArticle(article: Article, summary: Summary): Promise<void> {
  const caption = formatCaption(article, summary);

  if (!article.imageUrl) {
    await sendTextMessage(article, caption);
    return;
  }

  try {
    await callApiWithRetry("sendPhoto", {
      chat_id: CHAT_ID,
      photo: article.imageUrl,
      caption: safeTrimEscaped(caption, MAX_CAPTION_LEN),
      parse_mode: "HTML",
    });
    return;
  } catch (err) {
    // CHỈ fallback nếu Telegram CHẮC CHẮN từ chối sendPhoto (status 400 + mô tả
    // liên quan ảnh/caption). Với 5xx / timeout / network → throw để pipeline
    // không gửi 2 lần (rủi ro dupe nếu sendPhoto thực ra đã thành công).
    if (isSafeToFallbackFromSendPhoto(err)) {
      const desc = (err as TelegramError).description ?? (err as Error).message;
      console.warn(
        `[telegram] sendPhoto rejected (${desc?.slice(0, 200)}). Safe to fall back to sendMessage.`,
      );
      await sendTextMessage(article, caption);
      return;
    }
    console.error(
      `[telegram] sendPhoto failed with potentially-delivered status — NOT falling back: ${(err as Error).message}`,
    );
    throw err;
  }
}
