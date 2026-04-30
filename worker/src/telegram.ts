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
 * Phase 19.7 (bilingual hybrid): brand hashtag auto-append cho mọi caption
 * có hashtag. Đảm bảo discovery + branding consistency. Không append nếu AI
 * đã có sẵn (case-insensitive dedupe).
 */
const BRAND_HASHTAG = "TechBuzzDaily";
const MAX_HASHTAGS_RENDERED = 5;
const SEPARATOR_LINE = "━━━━━━━━━━";

/**
 * Format caption với smart truncation cho schema bilingual hybrid (Phase 19.7):
 *
 *   <b>title</b>
 *
 *   • bullet 1
 *   • bullet 2
 *   • bullet 3
 *
 *   💡 <b>Vì sao đáng đọc:</b> whyItMatters
 *
 *   ━━━━━━━━━━
 *   🌐 <i>EN:</i> enTldr                  ← optional, Phase 19.7
 *
 *   🔗 <a href="article.link">article.link</a>
 *
 *   — 🐝 <b>Tech Buzz Daily</b> · @techbuzz_daily
 *
 *   #AI #OpenAI #TechBuzzDaily            ← optional, Phase 19.7
 *
 * Quy tắc cắt (priority cao → thấp khi caption tràn budget):
 * 1. Drop hashtag line (chỉ là discovery aid, không mất nội dung).
 * 2. Drop EN section (separator + EN line) — người Việt vẫn đọc được full.
 * 3. Cắt bullets từ cuối (existing behavior).
 * 4. Last resort: cắt link text giữ href.
 *
 * Backward compat: nếu enTldr rỗng (provider trả schema cũ) → skip section
 * EN tự động, không cần check ở caller.
 */
function formatCaption(
  article: Article,
  summary: Summary,
  env: Env,
  maxLen: number,
): string {
  // Hard cap raw text trước khi escape, tránh Gemini trả về quá dài.
  const rawTitle = summary.title.slice(0, 150);
  const rawWhy = summary.whyItMatters.slice(0, 320);
  const rawEnTldr = (summary.enTldr ?? "").trim().slice(0, 200);
  const renderedHashtags = buildHashtagList(summary.hashtags ?? []);

  const title = escapeHtml(rawTitle);
  const why = escapeHtml(rawWhy);
  const linkHref = escapeHtmlAttr(article.link);
  let linkText = escapeHtml(article.link);

  const titleLine = `<b>${title}</b>`;
  const whyLine = `💡 <b>Vì sao đáng đọc:</b> ${why}`;
  const signatureLine = buildSignatureLine(env);
  let linkLine = `🔗 <a href="${linkHref}">${linkText}</a>`;

  // Optional sections (rỗng nếu không có data)
  const enBlock = rawEnTldr
    ? `${SEPARATOR_LINE}\n🌐 <i>EN:</i> ${escapeHtml(rawEnTldr)}`
    : "";
  const hashtagLine = renderedHashtags.length > 0
    ? renderedHashtags.map((h) => "#" + h).join(" ")
    : "";

  // Layout sections joined by "\n\n":
  //   [title, bullets?, why, enBlock?, link, signature, hashtagLine?]
  // Mỗi gap "\n\n" = 2 chars. Tổng gaps = (số section) - 1.
  const MIN_BULLETS_BUDGET = 30;

  // computeBulletsBudget: tính budget RAW còn lại cho bullets section
  // (đã trừ tất cả fixed sections + gaps), giả định bullets có mặt.
  const computeBulletsBudget = (includeEn: boolean, includeHashtag: boolean): number => {
    let len = titleLine.length + whyLine.length + linkLine.length + signatureLine.length;
    let sectionCount = 4; // title, why, link, signature
    if (includeEn && enBlock) {
      len += enBlock.length;
      sectionCount += 1;
    }
    if (includeHashtag && hashtagLine) {
      len += hashtagLine.length;
      sectionCount += 1;
    }
    // Bullets section thêm 1 → tổng sections = sectionCount + 1, gaps = sectionCount.
    const gaps = sectionCount * 2;
    return maxLen - len - gaps;
  };

  // Try full layout, drop optional sections theo priority nếu thiếu chỗ.
  let useEn = enBlock.length > 0;
  let useHashtag = hashtagLine.length > 0;
  let bulletsBudget = computeBulletsBudget(useEn, useHashtag);

  if (bulletsBudget < MIN_BULLETS_BUDGET && useHashtag) {
    useHashtag = false;
    bulletsBudget = computeBulletsBudget(useEn, false);
  }
  if (bulletsBudget < MIN_BULLETS_BUDGET && useEn) {
    useEn = false;
    bulletsBudget = computeBulletsBudget(false, false);
  }

  // Last resort: nếu fixed parts (title + why + link + signature) đã quá lớn
  // → cắt link TEXT (giữ href nguyên). Chỉ áp dụng khi đã drop hết optional.
  if (bulletsBudget < MIN_BULLETS_BUDGET) {
    const overhead =
      titleLine.length +
      whyLine.length +
      signatureLine.length +
      8 + // 4 gaps × 2 chars
      `🔗 <a href="${linkHref}"></a>`.length +
      30;
    const linkBudget = maxLen - overhead;
    if (linkBudget > 20 && linkText.length > linkBudget) {
      linkText = linkText.slice(0, linkBudget - 3) + "...";
      linkLine = `🔗 <a href="${linkHref}">${linkText}</a>`;
      bulletsBudget = computeBulletsBudget(false, false);
    }
  }

  const bulletsRendered = renderBullets(summary.bullets, bulletsBudget);

  // Assemble final caption (skip empty sections để không có "\n\n\n" thừa).
  const parts: string[] = [titleLine];
  if (bulletsRendered) parts.push(bulletsRendered);
  parts.push(whyLine);
  if (useEn && enBlock) parts.push(enBlock);
  parts.push(linkLine);
  parts.push(signatureLine);
  if (useHashtag && hashtagLine) parts.push(hashtagLine);

  return parts.join("\n\n");
}

/**
 * Phase 19.7: build danh sách hashtag CUỐI CÙNG để render (đã sanitize ở
 * tầng AI parse — xem `sanitizeRawHashtags` trong ai.ts).
 *
 * Logic:
 * - Lấy max 4 hashtag đầu từ AI (giữ chỗ cho brand hashtag).
 * - Auto-append `TechBuzzDaily` nếu chưa có (case-insensitive dedupe).
 * - Cap tổng cộng 5 hashtag (Telegram caption tight, > 5 trông spam).
 *
 * Không escape ở đây vì hashtag đã enforce alphanumeric ASCII tại
 * sanitizeRawHashtags → không có ký tự HTML cần escape.
 */
function buildHashtagList(rawFromAi: readonly string[]): string[] {
  const out: string[] = [];
  for (const h of rawFromAi) {
    if (typeof h !== "string" || h.length === 0) continue;
    if (out.some((existing) => existing.toLowerCase() === h.toLowerCase())) continue;
    out.push(h);
    if (out.length >= MAX_HASHTAGS_RENDERED - 1) break; // chừa 1 slot cho brand
  }
  // Phase 19.7: chỉ append brand khi AI có trả ≥1 hashtag — tránh hiển thị
  // hashtag "#TechBuzzDaily" đơn độc khi backward compat schema cũ trả [].
  // Khi AI mới có hashtag, brand luôn được append (case-insensitive dedupe
  // phòng AI tự thêm "TechBuzzDaily" vào).
  if (out.length === 0) return [];
  const hasBrand = out.some((h) => h.toLowerCase() === BRAND_HASHTAG.toLowerCase());
  if (!hasBrand && out.length < MAX_HASHTAGS_RENDERED) {
    out.push(BRAND_HASHTAG);
  }
  return out;
}

/**
 * Render bullets thành block "• ...\n• ...". Cắt từ cuối nếu vượt budget.
 * Trả "" nếu không bullet nào fit.
 */
function renderBullets(bullets: readonly string[], budget: number): string {
  if (bullets.length === 0 || budget < 10) return "";
  const PREFIX = "• ";
  const NL = "\n";

  // Thử full rồi giảm dần số bullet
  for (let n = bullets.length; n >= 1; n--) {
    const subset = bullets.slice(0, n);
    const lines: string[] = [];
    let remaining = budget;
    let fits = true;
    for (let i = 0; i < subset.length; i++) {
      const isLast = i === subset.length - 1;
      const sepCost = isLast ? 0 : NL.length;
      // Cost cho 1 bullet: prefix + escaped(text) + sep
      const escaped = escapeHtml(subset[i]);
      const cost = PREFIX.length + escaped.length + sepCost;
      if (cost <= remaining) {
        lines.push(PREFIX + escaped);
        remaining -= cost;
      } else if (isLast && remaining > PREFIX.length + 10) {
        // Bullet cuối được phép truncate
        const innerBudget = remaining - PREFIX.length;
        const truncated = truncateRawByEscapedBudget(subset[i], innerBudget);
        lines.push(PREFIX + truncated);
        remaining = 0;
      } else {
        fits = false;
        break;
      }
    }
    if (fits && lines.length > 0) return lines.join(NL);
  }
  return "";
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

/**
 * Helpers for testing.
 */
export const __test = {
  formatCaption,
  buildHashtagList,
};

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
    // TẮT HẲN web preview của Telegram. Lý do: caption mình đã có title VN
    // (Gen Z), nội dung VN, nguồn, link rồi. Nếu để Telegram tự fetch link
    // → preview sẽ hiện title + description tiếng Anh gốc của arxiv/wired/...
    // PHÍA TRÊN text Việt → trông như có 2 bài chồng nhau, rất xấu.
    link_preview_options: { is_disabled: true },
  });
}

/**
 * Gửi cảnh báo riêng cho admin (KHÔNG đăng vào channel chính).
 *
 * - Đích đến: `env.TELEGRAM_ADMIN_CHAT_ID` (DM admin hoặc 1 channel test riêng).
 * - Nếu env var không set → no-op (return false). Bot chạy bình thường, KHÔNG
 *   raise lỗi — alert là tính năng optional.
 * - parse_mode `HTML`, link preview tắt (giống postArticle, tránh embed lung tung).
 * - disable_notification = false → admin nhận push notification (đây LÀ alert,
 *   cần thấy ngay, không silent).
 * - Lỗi gửi (network / 401 / 403) được CATCH ngay tại đây và log; KHÔNG throw
 *   ra ngoài để pipeline chính vẫn tiếp tục — slot quan trọng hơn alert.
 *
 * Trả về `true` nếu đã gửi thành công, `false` nếu skip (không cấu hình) hoặc
 * gặp lỗi (đã log).
 */
export async function sendAdminAlert(
  env: Env & { TELEGRAM_ADMIN_CHAT_ID?: string },
  text: string,
): Promise<boolean> {
  const adminId = env.TELEGRAM_ADMIN_CHAT_ID?.trim();
  if (!adminId) return false;
  try {
    await callApiWithRetry(env, "sendMessage", {
      chat_id: adminId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    return true;
  } catch (err) {
    console.error(
      `[telegram] sendAdminAlert failed (admin=${adminId.slice(0, 12)}…): ` +
        `${(err as Error).message?.slice(0, 200)}`,
    );
    return false;
  }
}

export async function postArticle(
  article: Article,
  summary: Summary,
  env: Env,
): Promise<void> {
  // article.imageUrl được pipeline upstream (runBotInternal) bù bằng og:image
  // crawl nếu RSS không kèm ảnh. Tới đây nếu vẫn rỗng → thật sự không có ảnh
  // → fallback text-only (đã tắt link preview để tránh title English chèn vào).
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
