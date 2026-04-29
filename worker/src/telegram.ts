import type { Article } from "./rss.js";
import type { Summary } from "./ai.js";
import type { Env } from "./index.js";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

/**
 * Cắt body RAW (chưa escape) sao cho `escapeHtml(result)` <= budget.
 * Dùng binary search để TRÁNH cắt giữa entity HTML như &amp;.
 *
 * Exported chủ yếu cho test (xem worker/test/run-tests.ts).
 */
export function truncateRawByEscapedBudget(raw: string, budget: number): string {
  const escaped = escapeHtml(raw);
  if (escaped.length <= budget) return escaped;
  const ellipsis = "...";
  // Tìm độ dài raw lớn nhất sao cho escapeHtml(raw.slice(0, n) + "...").length <= budget
  let lo = 0;
  let hi = raw.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const candidate = raw.slice(0, mid) + ellipsis;
    if (escapeHtml(candidate).length <= budget) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return escapeHtml(raw.slice(0, lo) + ellipsis);
}

function buildSignatureLine(env: Env): string {
  const name = env.TELEGRAM_SIGNATURE ?? "Tech Buzz Daily";
  const emoji = env.TELEGRAM_SIGNATURE_EMOJI ?? "🐝";
  const chatId = env.TELEGRAM_CHANNEL_ID;
  const handle = chatId.startsWith("@") ? chatId.slice(1) : null;

  const brand = `${emoji} <b>${escapeHtml(name)}</b>`;
  if (!handle) return `— ${brand}`;
  const handleLink = `<a href="https://t.me/${escapeHtmlAttr(handle)}">@${escapeHtml(handle)}</a>`;
  return `— ${brand} · ${handleLink}`;
}

/**
 * Format caption với smart truncation:
 * - Title / takeaway / link / signature giữ nguyên vẹn (không bao giờ cắt giữa HTML tag).
 * - Chỉ cắt phần `body` (text thuần, không HTML) nếu tổng vượt maxLen.
 * - Trường hợp cực hiếm (title + takeaway + link đã quá dài), cắt link text (giữ href).
 */
function formatCaption(
  article: Article,
  summary: Summary,
  env: Env,
  maxLen: number,
): string {
  // Hard cap raw text trước khi escape, tránh Gemini trả về quá dài.
  const rawTitle = summary.title.slice(0, 150);
  const rawTakeaway = summary.takeaway.slice(0, 280);

  const title = escapeHtml(rawTitle);
  const takeaway = escapeHtml(rawTakeaway);
  const linkHref = escapeHtmlAttr(article.link);
  let linkText = escapeHtml(article.link);

  const titleLine = `<b>${title}</b>`;
  const takeawayLine = `💡 ${takeaway}`;
  const signatureLine = buildSignatureLine(env);

  // 4 separator (mỗi cái 2 newline) = 8 chars khoảng cách
  const SEP_LEN = 8;

  // Build link line, có thể cắt linkText nếu cần (giữ href nguyên vẹn)
  let linkLine = `🔗 <a href="${linkHref}">${linkText}</a>`;
  let fixedLen = titleLine.length + takeawayLine.length + linkLine.length + signatureLine.length + SEP_LEN;

  // Nếu fixed parts đã vượt → cắt link TEXT (KHÔNG cắt href, không bể HTML)
  if (fixedLen >= maxLen - 30) {
    const overhead = titleLine.length + takeawayLine.length + signatureLine.length + SEP_LEN +
      `🔗 <a href="${linkHref}"></a>`.length + 30;
    const linkBudget = maxLen - overhead;
    if (linkBudget > 20 && linkText.length > linkBudget) {
      linkText = linkText.slice(0, linkBudget - 3) + "...";
      linkLine = `🔗 <a href="${linkHref}">${linkText}</a>`;
      fixedLen = titleLine.length + takeawayLine.length + linkLine.length + signatureLine.length + SEP_LEN;
    }
  }

  // Tính budget cho body, escape sau khi cắt
  const bodyBudget = maxLen - fixedLen;
  if (bodyBudget < 30) {
    // Cực hiếm: không còn chỗ → bỏ body, ghép phần còn lại
    return [titleLine, "", takeawayLine, "", linkLine, "", signatureLine].join("\n");
  }
  // QUAN TRỌNG: KHÔNG slice trên escaped string (có thể cắt giữa &amp; → broken HTML).
  // Thay vào đó, binary-search độ dài raw sao cho escaped bằng đúng budget.
  const escapedBody = truncateRawByEscapedBudget(summary.body, bodyBudget);

  return [
    titleLine,
    "",
    escapedBody,
    "",
    takeawayLine,
    "",
    linkLine,
    "",
    signatureLine,
  ].join("\n");
}

type TelegramResponse = {
  ok: boolean;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
  result?: unknown;
};

export class TelegramError extends Error {
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

const TELEGRAM_TIMEOUT_MS = 15_000;

async function rawCall(
  env: Env,
  method: string,
  body: Record<string, unknown>,
): Promise<TelegramResponse> {
  const api = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${api}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new TelegramError(
        `Telegram ${method} timeout after ${TELEGRAM_TIMEOUT_MS}ms`,
        408,
      );
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
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
 * Quyết định có an toàn để FALLBACK từ sendPhoto → sendMessage hay không.
 *
 * Nguyên tắc: chỉ fallback khi CHẮC CHẮN sendPhoto KHÔNG được nhận thành công
 * bởi Telegram (tức không có rủi ro post 2 lần).
 *
 * AN TOÀN fallback (request bị Telegram từ chối ngay → không có msg nào tới channel):
 *  - status 400 Bad Request với description liên quan tới ảnh / URL ảnh:
 *    "wrong file identifier", "WEBPAGE_CURL_FAILED", "PHOTO_INVALID_DIMENSIONS",
 *    "Image_process_failed", "wrong type of the web page content", "failed to get HTTP URL content",
 *    "wrong remote file identifier", "wrong remote photo URL".
 *  - status 400 với description liên quan caption length: "caption is too long".
 *
 * KHÔNG an toàn (rủi ro post 2 lần):
 *  - status 5xx (server error) — sendPhoto có thể đã gửi xong nhưng response lỗi
 *  - status 408/timeout — không biết Telegram có nhận được hay không
 *  - status 401/403 — auth fail, fallback cũng fail thôi, không có ích
 *  - status 429 — đã retry ở rawCall, không nên gửi 2 lần
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
  return err instanceof Error && (err.name === "TypeError" || err.message.includes("fetch"));
}

async function callApiWithRetry(
  env: Env,
  method: string,
  body: Record<string, unknown>,
  maxRetries = 4,
): Promise<TelegramResponse> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await rawCall(env, method, body);
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

async function sendTextMessage(
  article: Article,
  summary: Summary,
  env: Env,
): Promise<void> {
  const textForMessage = formatCaption(article, summary, env, MAX_MESSAGE_LEN);
  await callApiWithRetry(env, "sendMessage", {
    chat_id: env.TELEGRAM_CHANNEL_ID,
    text: textForMessage,
    parse_mode: "HTML",
    link_preview_options: {
      is_disabled: false,
      url: article.link,
      show_above_text: true,
      prefer_large_media: true,
    },
  });
}

export async function postArticle(
  article: Article,
  summary: Summary,
  env: Env,
): Promise<void> {
  if (!article.imageUrl) {
    await sendTextMessage(article, summary, env);
    return;
  }

  const captionForPhoto = formatCaption(article, summary, env, MAX_CAPTION_LEN);
  try {
    await callApiWithRetry(env, "sendPhoto", {
      chat_id: env.TELEGRAM_CHANNEL_ID,
      photo: article.imageUrl,
      caption: captionForPhoto,
      parse_mode: "HTML",
    });
    return;
  } catch (err) {
    // CHỈ fallback nếu Telegram trả 400 với mô tả lỗi liên quan ảnh/caption.
    // Với 5xx / timeout / network error → KHÔNG fallback (rủi ro post 2 lần).
    if (isSafeToFallbackFromSendPhoto(err)) {
      const desc = (err as TelegramError).description ?? (err as Error).message;
      console.warn(
        `[telegram] sendPhoto rejected by Telegram (${desc?.slice(0, 200)}). ` +
          `Safe to fall back to sendMessage (no photo was delivered).`,
      );
      await sendTextMessage(article, summary, env);
      return;
    }
    // Không an toàn để fallback → throw để pipeline rollback reservation + đánh fail count.
    console.error(
      `[telegram] sendPhoto failed with potentially-delivered status — NOT falling back. Error: ${(err as Error).message}`,
    );
    throw err;
  }
}
