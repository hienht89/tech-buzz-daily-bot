import {
  RSS_SOURCES,
  isTechRelevantUrl,
  isTechRelevantTitle,
} from "./sources.js";
import { fetchAllSources, type Article } from "./rss.js";
import { summarizeArticle } from "./ai.js";
import { postArticle } from "./telegram.js";
import {
  isPosted,
  reservePost,
  unreservePost,
  getFailCount,
  incrementFailCount,
  clearFailCount,
  MAX_FAIL_BEFORE_SKIP,
} from "./storage.js";

export interface Env {
  POSTED_KV: KVNamespace;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHANNEL_ID: string;
  GOOGLE_API_KEY: string;
  TELEGRAM_SIGNATURE?: string;
  TELEGRAM_SIGNATURE_EMOJI?: string;
  /**
   * Token RIÊNG để bảo vệ endpoint POST /run (manual trigger).
   * Phải set bằng `wrangler secret put RUN_TRIGGER_TOKEN` (KHÔNG dùng chung TELEGRAM_BOT_TOKEN).
   * Nếu không set, endpoint /run sẽ bị tắt hoàn toàn.
   */
  RUN_TRIGGER_TOKEN?: string;
}

const MAX_AGE_HOURS = 48;

function isFresh(article: Article): boolean {
  return Date.now() - article.pubDate.getTime() <= MAX_AGE_HOURS * 60 * 60 * 1000;
}

async function pickArticle(env: Env): Promise<Article | null> {
  console.log(`[bot] Fetching ${RSS_SOURCES.length} RSS sources...`);
  const allArticles = await fetchAllSources(RSS_SOURCES);
  console.log(`[bot] Fetched ${allArticles.length} total articles (top-N after sort)`);

  // Lọc tách bước để log từng giai đoạn — biết bài nào bị loại vì lý do gì.
  const fresh = allArticles.filter(isFresh);
  const techUrl = fresh.filter((a) => isTechRelevantUrl(a.link));
  const candidates = techUrl.filter((a) => isTechRelevantTitle(a.title));
  console.log(
    `[bot] Filter pipeline: total=${allArticles.length} fresh=${fresh.length} ` +
      `tech-url=${techUrl.length} tech-title=${candidates.length}`,
  );

  if (candidates.length === 0) {
    console.warn(
      "[bot] No candidates after filtering. Có thể: (1) tất cả nguồn RSS fail, " +
        "(2) tin quá cũ (>48h), (3) filter từ khóa quá chặt.",
    );
    return null;
  }

  // Đi từ bài mới nhất xuống, bỏ qua: (a) đã đăng, (b) poison (fail >= MAX).
  let checked = 0;
  let skippedPosted = 0;
  let skippedPoison = 0;
  for (const a of candidates) {
    checked++;
    if (await isPosted(env, a.link)) {
      skippedPosted++;
      continue;
    }
    const failCount = await getFailCount(env, a.link);
    if (failCount >= MAX_FAIL_BEFORE_SKIP) {
      skippedPoison++;
      console.warn(
        `[bot] Skipping poison article (fail=${failCount}): "${a.title.slice(0, 80)}"`,
      );
      continue;
    }
    console.log(
      `[bot] Picked after checking ${checked}/${candidates.length} ` +
        `(skipped: ${skippedPosted} posted, ${skippedPoison} poison)`,
    );
    return a;
  }
  console.warn(
    `[bot] No usable article in ${candidates.length} candidates ` +
      `(${skippedPosted} đã đăng, ${skippedPoison} poison). Đợi cron tiếp.`,
  );
  return null;
}

async function runBot(env: Env): Promise<void> {
  const article = await pickArticle(env);
  if (!article) {
    console.log("[bot] No fresh unposted article found. Skipping this run.");
    return;
  }

  console.log(`[bot] Selected: "${article.title}" (${article.source})`);
  console.log(`[bot]   Link: ${article.link}`);

  // ────────── Bước 1: Gemini summarize ──────────
  // Nếu fail → tăng fail count nhưng KHÔNG throw để cron tiếp tự pick bài khác.
  // Sau MAX_FAIL_BEFORE_SKIP lần, bài này sẽ bị skip trong pickArticle.
  let summary;
  try {
    console.log("[bot] Generating Vietnamese summary with Gemini...");
    summary = await summarizeArticle(article, env);
    console.log(`[bot]   Title: ${summary.title}`);
  } catch (err) {
    const fc = await incrementFailCount(env, article.link).catch(() => -1);
    console.error(
      `[bot] Gemini failed for "${article.title}" (fail count → ${fc}): ${(err as Error).message}`,
    );
    return; // không throw → cron không bị mark fail, slot tiếp vẫn chạy
  }

  // ────────── Bước 2: Reserve KV NGAY trước khi gửi Telegram ──────────
  await reservePost(env, article.link, summary.title);

  // ────────── Bước 3: Post lên Telegram ──────────
  try {
    console.log("[bot] Posting to Telegram channel...");
    await postArticle(article, summary, env);
    console.log("[bot] Done!");
    // Post thành công → xóa fail count (nếu trước đó từng fail nhưng giờ ok)
    await clearFailCount(env, article.link).catch(() => undefined);
  } catch (err) {
    // Telegram fail → rollback KV reservation và tăng fail count
    console.error(
      `[bot] Telegram post failed; rolling back. Error: ${(err as Error).message}`,
    );
    await unreservePost(env, article.link).catch((e) => {
      console.warn(`[bot] Unreserve also failed: ${(e as Error).message}`);
    });
    const fc = await incrementFailCount(env, article.link).catch(() => -1);
    console.warn(`[bot] Fail count for this URL → ${fc}`);
    return; // không throw → slot kế cứ thử bài khác
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const startedAt = new Date().toISOString();
    console.log(`[bot] Cron triggered at ${startedAt} (UTC)`);
    ctx.waitUntil(
      runBot(env).catch((err) => {
        console.error("[bot] FATAL:", err);
        throw err;
      }),
    );
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return new Response("ok\n", { status: 200 });
    }

    if (url.pathname === "/run") {
      // CHỈ chấp nhận POST + Authorization: Bearer <RUN_TRIGGER_TOKEN>
      if (req.method !== "POST") {
        return new Response("Method Not Allowed. Use POST.\n", {
          status: 405,
          headers: { Allow: "POST" },
        });
      }
      if (!env.RUN_TRIGGER_TOKEN) {
        return new Response("Manual trigger disabled (RUN_TRIGGER_TOKEN not set).\n", {
          status: 503,
        });
      }
      const auth = req.headers.get("Authorization") ?? "";
      const match = auth.match(/^Bearer\s+(.+)$/);
      if (!match || !timingSafeEqual(match[1], env.RUN_TRIGGER_TOKEN)) {
        return new Response("Unauthorized\n", { status: 401 });
      }
      ctx.waitUntil(
        runBot(env).catch((err) => {
          console.error("[bot] FATAL (manual trigger):", err);
        }),
      );
      return new Response(
        "Bot triggered manually. Check `wrangler tail` for logs.\n",
        { status: 202 },
      );
    }

    return new Response(
      "Tech Buzz Daily bot worker.\nEndpoints: GET /health, POST /run\n",
      { status: 200, headers: { "Content-Type": "text/plain" } },
    );
  },
} satisfies ExportedHandler<Env>;
