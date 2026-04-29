import {
  RSS_SOURCES,
  isTechRelevantUrl,
  isTechRelevantTitle,
} from "./sources.js";
import { fetchAllSources, type Article, type SourceStat } from "./rss.js";
import { summarizeArticle } from "./ai.js";
import { postArticle } from "./telegram.js";
import { extractOgImage } from "./og.js";
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

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

const MAX_AGE_HOURS = 48;

/**
 * Số lượng candidate tối đa thử trong 1 lần chạy.
 * Nếu Gemini hoặc Telegram fail bài đầu, bot sẽ tự thử tiếp bài tiếp theo
 * cho đến khi post thành công hoặc hết MAX_CANDIDATES_PER_RUN.
 * Tránh trường hợp 1 bài hỏng làm miss cả slot.
 */
const MAX_CANDIDATES_PER_RUN = 5;

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function isFresh(article: Article): boolean {
  return Date.now() - article.pubDate.getTime() <= MAX_AGE_HOURS * 60 * 60 * 1000;
}

function shortRunId(): string {
  // 8 hex chars là đủ unique cho mỗi cron tick
  return crypto.randomUUID().slice(0, 8);
}

/**
 * Single-flight mutex Ở MỨC ISOLATE. Đảm bảo trong cùng 1 Worker isolate (cùng
 * 1 instance đang warm), CHỈ 1 lần runBot chạy cùng lúc. Áp dụng cho trường
 * hợp manual `/run` được trigger gần như cùng lúc với cron trigger.
 *
 * HẠN CHẾ: nếu Cloudflare load-balance cron và fetch tới 2 isolate khác nhau
 * (vd 2 datacenter khác nhau), mutex này KHÔNG bảo vệ được. Race giữa 2
 * isolate là KÝ ƯU NHỎ vì:
 *   - Cron fire ở 1 thời điểm (top-of-hour), manual trigger hiếm
 *   - KV `isPosted` re-check ngay trước reservePost vẫn catch hầu hết trường hợp
 *   - Bot tự nhận chỉ 18 post/ngày → cửa sổ race ~ms / mỗi 1h
 * Nếu cần bảo đảm tuyệt đối → cần Durable Objects (overhead + chi phí cao hơn,
 * không cần thiết cho scale hiện tại).
 */
let inflightRun: Promise<RunResult> | null = null;

type PickResult = {
  candidates: Article[];
  stats: SourceStat[];
  totalFetched: number;
  freshCount: number;
  techCount: number;
};

/**
 * Lấy DANH SÁCH (không phải 1 bài) candidates đã pass mọi filter và CHƯA đăng.
 * Caller (runBot) sẽ thử từng bài cho đến khi 1 bài post thành công.
 *
 * Filter pipeline (theo thứ tự, để log chỉ rõ stage nào loại nhiều bài):
 *  1. fresh: pubDate trong 48h
 *  2. tech-relevant URL (path không match blacklist)
 *  3. tech-relevant title (không match keyword blacklist)
 *  4. chưa được đăng (KV check)
 *  5. không phải poison article (fail count < MAX)
 */
async function pickCandidates(env: Env, runId: string): Promise<PickResult> {
  console.log(`[bot:${runId}] Fetching ${RSS_SOURCES.length} RSS sources...`);
  const { articles, stats } = await fetchAllSources(RSS_SOURCES);
  console.log(`[bot:${runId}] Fetched ${articles.length} articles (top-N after sort)`);

  const fresh = articles.filter(isFresh);
  const techUrl = fresh.filter((a) => isTechRelevantUrl(a.link));
  const techTitle = techUrl.filter((a) => isTechRelevantTitle(a.title));
  console.log(
    `[bot:${runId}] Filter pipeline: total=${articles.length} fresh=${fresh.length} ` +
      `tech-url=${techUrl.length} tech-title=${techTitle.length}`,
  );

  if (techTitle.length === 0) {
    return {
      candidates: [],
      stats,
      totalFetched: articles.length,
      freshCount: fresh.length,
      techCount: techTitle.length,
    };
  }

  // KV check (đã đăng) + poison check, trên TOÀN BỘ tech-relevant article
  // (không break sớm — runBot cần list để retry).
  const candidates: Article[] = [];
  let skippedPosted = 0;
  let skippedPoison = 0;
  for (const a of techTitle) {
    if (await isPosted(env, a.link)) {
      skippedPosted++;
      continue;
    }
    const fc = await getFailCount(env, a.link);
    if (fc >= MAX_FAIL_BEFORE_SKIP) {
      skippedPoison++;
      continue;
    }
    candidates.push(a);
    // Đã có đủ MAX_CANDIDATES_PER_RUN thì stop sớm (tiết kiệm KV reads)
    if (candidates.length >= MAX_CANDIDATES_PER_RUN) break;
  }

  console.log(
    `[bot:${runId}] Eligible candidates: ${candidates.length} ` +
      `(skipped: ${skippedPosted} đã đăng, ${skippedPoison} poison)`,
  );

  return {
    candidates,
    stats,
    totalFetched: articles.length,
    freshCount: fresh.length,
    techCount: techTitle.length,
  };
}

export type RunResult = {
  runId: string;
  posted: boolean;
  attempted: number;
  postedTitle?: string;
  postedSource?: string;
  postedLink?: string;
  reason?: string;
};

/**
 * Internal run. Không throw ra ngoài — mọi lỗi candidate đều được catch để
 * tiếp tục thử bài tiếp theo. Cron handler không bao giờ thấy exception.
 */
async function runBotInternal(
  env: Env,
  options: { dryRun?: boolean },
): Promise<RunResult> {
  const runId = shortRunId();
  const dry = !!options.dryRun;
  console.log(`[bot:${runId}] Run started${dry ? " (DRY RUN — sẽ KHÔNG post)" : ""}`);

  const pick = await pickCandidates(env, runId);

  if (pick.candidates.length === 0) {
    const reason = pick.totalFetched === 0
      ? "all RSS sources failed"
      : pick.freshCount === 0
        ? "no fresh articles (>48h)"
        : pick.techCount === 0
          ? "no tech-relevant articles after filter"
          : "all candidates đã đăng hoặc poison";
    console.warn(`[bot:${runId}] No candidate to try. Reason: ${reason}`);
    return { runId, posted: false, attempted: 0, reason };
  }

  for (let i = 0; i < pick.candidates.length; i++) {
    const article = pick.candidates[i];
    const tag = `[bot:${runId}] (${i + 1}/${pick.candidates.length})`;
    console.log(`${tag} Trying: "${article.title}" — ${article.source}`);
    console.log(`${tag}   Link: ${article.link}`);

    // Re-check posted ngay trước khi reserve — phòng race với 1 cron khác
    // (vd manual /run trong khi cron đang chạy).
    if (await isPosted(env, article.link)) {
      console.log(`${tag}   Race detected: bài đã được claim bởi run khác. Skip.`);
      continue;
    }

    // ───── Bước 1: Gemini summarize ─────
    let summary;
    try {
      console.log(`${tag}   Summarizing with Gemini...`);
      summary = await summarizeArticle(article, env);
      console.log(`${tag}   Title: ${summary.title}`);
    } catch (err) {
      const fc = await incrementFailCount(env, article.link).catch(() => -1);
      console.error(
        `${tag}   Gemini fail (count→${fc}): ${(err as Error).message?.slice(0, 200)}`,
      );
      continue; // thử bài tiếp theo
    }

    if (dry) {
      console.log(`${tag}   DRY RUN — would post: "${summary.title}"`);
      return {
        runId,
        posted: false,
        attempted: i + 1,
        postedTitle: summary.title,
        postedSource: article.source,
        postedLink: article.link,
        reason: "dry-run",
      };
    }

    // ───── Bước 2: Reserve KV (claim) NGAY trước khi gọi Telegram ─────
    // Nếu reserve fail → KHÔNG bỏ run, thử bài tiếp theo (slot vẫn còn cơ hội).
    try {
      await reservePost(env, article.link, summary.title);
    } catch (err) {
      console.error(
        `${tag}   Reserve fail (KV write): ${(err as Error).message?.slice(0, 200)}. ` +
          `Bỏ qua bài này, thử bài tiếp theo.`,
      );
      // KHÔNG increment fail count vì lỗi không phải do bài này — do KV.
      continue;
    }

    // ───── Bước 2.5: Bù ảnh từ og:image nếu RSS không kèm ảnh ─────
    // Lý do: nguồn như arxiv KHÔNG embed ảnh trong feed. Trước đây bot
    // fallback về sendMessage (text-only), post trông trống. Best-effort
    // fetch trang gốc parse <meta og:image>; thất bại → giữ nguyên (postArticle
    // tự fallback text-only đã tắt link preview để không có title English).
    if (!article.imageUrl) {
      const og = await extractOgImage(article.link);
      if (og) {
        console.log(`${tag}   og:image found → upgrade text→photo post`);
        article.imageUrl = og;
      }
    }

    // ───── Bước 3: Post lên Telegram ─────
    try {
      console.log(`${tag}   Posting to Telegram...`);
      await postArticle(article, summary, env);
      await clearFailCount(env, article.link).catch(() => undefined);
      console.log(`${tag}   ✅ Posted successfully.`);
      return {
        runId,
        posted: true,
        attempted: i + 1,
        postedTitle: summary.title,
        postedSource: article.source,
        postedLink: article.link,
      };
    } catch (err) {
      console.error(
        `${tag}   Telegram fail: ${(err as Error).message?.slice(0, 200)}`,
      );

      // ───── Bước 4: Rollback reservation ─────
      // Nếu unreserve fail → posted:* key vẫn nằm trong KV 30 ngày → bài này
      // sẽ bị skip vĩnh viễn DÙ CHƯA THỰC SỰ ĐĂNG. Đây là lỗi hệ thống
      // nghiêm trọng cần admin can thiệp. Log thật to + KHÔNG increment fail
      // count (vì fail count cũng vô ích — bài đã bị mark posted).
      let unreserveOk = true;
      try {
        await unreservePost(env, article.link);
      } catch (e) {
        unreserveOk = false;
        console.error(
          `${tag}   ⚠️ CRITICAL: unreserve cũng fail. Bài "${article.title}" ` +
            `(${article.link}) đã bị mark posted trong KV NHƯNG CHƯA gửi lên Telegram. ` +
            `Sẽ bị skip 30 ngày. Cần xóa thủ công posted:<sha1(canonical)> trong KV. ` +
            `Error: ${(e as Error).message?.slice(0, 200)}`,
        );
      }

      if (unreserveOk) {
        const fc = await incrementFailCount(env, article.link).catch(() => -1);
        console.warn(`${tag}   Fail count → ${fc}`);
      }
      continue; // thử bài tiếp theo
    }
  }

  console.warn(
    `[bot:${runId}] Tried all ${pick.candidates.length} candidates, none succeeded.`,
  );
  return {
    runId,
    posted: false,
    attempted: pick.candidates.length,
    reason: "all candidates failed",
  };
}

/**
 * Public entry. Wrap `runBotInternal` trong single-flight mutex để 2 lần gọi
 * trong cùng 1 isolate (vd cron + manual /run đến gần như cùng lúc) sẽ KHÔNG
 * chạy song song → giảm rủi ro post trùng. Xem comment ở `inflightRun` trên
 * cho hạn chế cross-isolate.
 */
export async function runBot(
  env: Env,
  options: { dryRun?: boolean } = {},
): Promise<RunResult> {
  if (inflightRun) {
    console.log(
      `[bot] Có 1 run đang chạy trong cùng isolate, đợi xong rồi mới start (single-flight).`,
    );
    await inflightRun.catch(() => undefined);
  }
  const promise = runBotInternal(env, options);
  inflightRun = promise;
  try {
    return await promise;
  } finally {
    if (inflightRun === promise) inflightRun = null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Auth helpers
// ────────────────────────────────────────────────────────────────────────────

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function isAuthorized(req: Request, env: Env): boolean {
  if (!env.RUN_TRIGGER_TOKEN) return false;
  const auth = req.headers.get("Authorization") ?? "";
  const match = auth.match(/^Bearer\s+(.+)$/);
  if (!match) return false;
  return timingSafeEqual(match[1], env.RUN_TRIGGER_TOKEN);
}

// ────────────────────────────────────────────────────────────────────────────
// Worker entry
// ────────────────────────────────────────────────────────────────────────────

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
        // runBot không nên throw, nhưng phòng lỗi lập trình.
        console.error("[bot] FATAL (cron):", err);
      }),
    );
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // ───── /health: ping endpoint ─────
    if (url.pathname === "/health") {
      return new Response("ok\n", { status: 200 });
    }

    // ───── /sources: source health (cần auth) ─────
    if (url.pathname === "/sources") {
      if (!isAuthorized(req, env)) {
        return new Response("Unauthorized\n", { status: 401 });
      }
      const { stats } = await fetchAllSources(RSS_SOURCES);
      const total = stats.length;
      const ok = stats.filter((s) => s.ok).length;
      const body = {
        total,
        ok,
        failed: total - ok,
        sources: stats.sort((a, b) => Number(a.ok) - Number(b.ok) || b.count - a.count),
        checkedAt: new Date().toISOString(),
      };
      return new Response(JSON.stringify(body, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ───── /run: manual trigger (cần auth) ─────
    if (url.pathname === "/run") {
      if (req.method !== "POST") {
        return new Response("Method Not Allowed. Use POST.\n", {
          status: 405,
          headers: { Allow: "POST" },
        });
      }
      if (!env.RUN_TRIGGER_TOKEN) {
        return new Response(
          "Manual trigger disabled (RUN_TRIGGER_TOKEN not set).\n",
          { status: 503 },
        );
      }
      if (!isAuthorized(req, env)) {
        return new Response("Unauthorized\n", { status: 401 });
      }

      const dry = url.searchParams.get("dry") === "1" || url.searchParams.get("dry") === "true";

      // Dry-run: chạy SYNC để trả kết quả về client (không post nên rất nhanh)
      if (dry) {
        try {
          const result = await runBot(env, { dryRun: true });
          return new Response(JSON.stringify(result, null, 2), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        } catch (err) {
          return new Response(
            JSON.stringify({ error: (err as Error).message }, null, 2),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
      }

      // Real run: ASYNC để không bị giới hạn 30s của fetch handler
      ctx.waitUntil(
        runBot(env).catch((err) => {
          console.error("[bot] FATAL (manual):", err);
        }),
      );
      return new Response(
        "Bot triggered manually. Check `wrangler tail` for logs.\n",
        { status: 202 },
      );
    }

    return new Response(
      "Tech Buzz Daily bot worker.\n" +
        "Endpoints:\n" +
        "  GET  /health                 — ping\n" +
        "  POST /run (Bearer)           — trigger ngay (async)\n" +
        "  POST /run?dry=1 (Bearer)     — dry-run, trả về candidate sẽ chọn (KHÔNG post)\n" +
        "  GET  /sources (Bearer)       — source health report\n",
      { status: 200, headers: { "Content-Type": "text/plain" } },
    );
  },
} satisfies ExportedHandler<Env>;
