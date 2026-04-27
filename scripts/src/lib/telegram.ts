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
  constructor(message: string, status: number, retryAfter?: number) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
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
    );
  }
  return data;
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

function trimToLength(caption: string, max: number): string {
  if (caption.length <= max) return caption;
  return caption.slice(0, max - 3) + "...";
}

export async function postArticle(article: Article, summary: Summary): Promise<void> {
  const caption = formatCaption(article, summary);

  if (article.imageUrl) {
    try {
      await callApiWithRetry("sendPhoto", {
        chat_id: CHAT_ID,
        photo: article.imageUrl,
        caption: trimToLength(caption, MAX_CAPTION_LEN),
        parse_mode: "HTML",
      });
      return;
    } catch (err) {
      // sendPhoto failures are often Bad Request (image format/size) — these are NOT retryable
      // and we just want to fall back to a text post in that case.
      console.warn(
        `[telegram] sendPhoto failed (${(err as Error).message}), falling back to sendMessage`,
      );
    }
  }

  await callApiWithRetry("sendMessage", {
    chat_id: CHAT_ID,
    text: trimToLength(caption, MAX_MESSAGE_LEN),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: false },
  });
}
