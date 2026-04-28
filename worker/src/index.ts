import {
  RSS_SOURCES,
  isTechRelevantUrl,
  isTechRelevantTitle,
} from "./sources.js";
import { fetchAllSources, type Article } from "./rss.js";
import { summarizeArticle } from "./ai.js";
import { postArticle } from "./telegram.js";
import { isPosted, reservePost, unreservePost } from "./storage.js";

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
  console.log(`[bot] Fetched ${allArticles.length} total articles`);

  // Lọc sơ bộ: tươi + tech-relevant
  const candidates = allArticles.filter(
    (a) => isFresh(a) && isTechRelevantUrl(a.link) && isTechRelevantTitle(a.title),
  );
  console.log(`[bot] ${candidates.length} fresh tech-relevant candidates`);

  // Đi từ bài mới nhất xuống, lấy bài đầu tiên CHƯA đăng (1 KV read mỗi bài, dừng sớm)
  for (const a of candidates) {
    if (!(await isPosted(env, a.link))) return a;
  }
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

  console.log("[bot] Generating Vietnamese summary with Gemini...");
  const summary = await summarizeArticle(article, env);
  console.log(`[bot]   Title: ${summary.title}`);

  // Đặt chỗ KV NGAY trước khi gửi Telegram (tránh dupe nếu cron + manual chạy đè).
  await reservePost(env, article.link, summary.title);

  try {
    console.log("[bot] Posting to Telegram channel...");
    await postArticle(article, summary, env);
    console.log("[bot] Done!");
  } catch (err) {
    // Telegram fail → hủy đặt chỗ để lần sau retry.
    console.error("[bot] Telegram post failed; rolling back KV reservation");
    await unreservePost(env, article.link).catch((e) => {
      console.warn(`[bot] Unreserve also failed: ${(e as Error).message}`);
    });
    throw err;
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
