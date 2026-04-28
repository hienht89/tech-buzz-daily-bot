import type { Article } from "./rss.js";
import type { Summary } from "./ai.js";
import type { Env } from "./index.js";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
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

function formatCaption(article: Article, summary: Summary, env: Env): string {
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
    buildSignatureLine(env),
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
  env: Env,
  method: string,
  body: Record<string, unknown>,
): Promise<TelegramResponse> {
  const api = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
  const res = await fetch(`${api}/${method}`, {
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

function trimToLength(caption: string, max: number): string {
  if (caption.length <= max) return caption;
  return caption.slice(0, max - 3) + "...";
}

export async function postArticle(
  article: Article,
  summary: Summary,
  env: Env,
): Promise<void> {
  const caption = formatCaption(article, summary, env);

  if (article.imageUrl) {
    try {
      await callApiWithRetry(env, "sendPhoto", {
        chat_id: env.TELEGRAM_CHANNEL_ID,
        photo: article.imageUrl,
        caption: trimToLength(caption, MAX_CAPTION_LEN),
        parse_mode: "HTML",
      });
      return;
    } catch (err) {
      console.warn(
        `[telegram] sendPhoto failed (${(err as Error).message}), falling back to sendMessage`,
      );
    }
  }

  await callApiWithRetry(env, "sendMessage", {
    chat_id: env.TELEGRAM_CHANNEL_ID,
    text: trimToLength(caption, MAX_MESSAGE_LEN),
    parse_mode: "HTML",
    link_preview_options: {
      is_disabled: false,
      url: article.link,
      show_above_text: true,
      prefer_large_media: true,
    },
  });
}
