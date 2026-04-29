import {
  RSS_SOURCES,
  isTechRelevantUrl,
  isTechRelevantTitle,
  type SourceCategory,
} from "./sources.js";
import { fetchAllSources, type Article, type SourceStat } from "./rss.js";
import { summarizeArticle } from "./ai.js";
import { postArticle } from "./telegram.js";
import { extractOgImage } from "./og.js";
import { isRelevantArxivPaper } from "./filter.js";
import { scoreArticle, formatBreakdown } from "./score.js";
import { clusterBatch, checkFuzzyDuplicate } from "./dedup.js";
import {
  DEFAULT_QUOTA,
  formatUsage,
  getAllUsage,
  incrementCategoryUsage,
  selectFromBuckets,
  todayKeyUTC,
} from "./bucket.js";
import {
  isPosted,
  isTitlePosted,
  reservePost,
  unreservePost,
  getFailCount,
  incrementFailCount,
  clearFailCount,
  markTitlePosted,
  pushRecentTitle,
  getRecentTitles,
  setLastPosted,
  getLastPosted,
  MAX_FAIL_BEFORE_SKIP,
} from "./storage.js";

export interface Env {
  POSTED_KV: KVNamespace;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHANNEL_ID: string;
  GOOGLE_API_KEY: string;
  /**
   * Gemini API key BỔ SUNG (mỗi key 1 tài khoản Google → 1 quota free riêng).
   * Bot tự gom tất cả key có sẵn và xoay vòng khi 1 key cạn quota.
   * Set tới `_5` nếu cần (xem `MAX_GEMINI_EXTRA_KEYS` trong ai.ts).
   */
  GOOGLE_API_KEY_1?: string;
  GOOGLE_API_KEY_2?: string;
  GOOGLE_API_KEY_3?: string;
  GOOGLE_API_KEY_4?: string;
  GOOGLE_API_KEY_5?: string;
  /**
   * OpenRouter API key — fallback khi Gemini hết quota (HTTP 429).
   * Optional: nếu không set, bot chỉ chạy với Gemini (như hành vi cũ).
   * Đăng ký free tại openrouter.ai → Settings → Keys.
   */
  OPENROUTER_API_KEY?: string;
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

// Phase 14: siết từ 48h → 30h. Channel daily news không cần bài >1 ngày tuổi;
// 30h cho slack qua múi giờ (bài Mỹ chiều → kịp post sáng VN ngày sau).
// Recency decay window trong score.ts vẫn 48h — bài 30h vẫn còn ~37/100 điểm
// recency, không bị 0, đủ để tie-break.
const MAX_AGE_HOURS = 30;

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
  /** Candidates đã qua mọi filter + dedup, sorted DESC theo score. */
  candidates: Article[];
  stats: SourceStat[];
  totalFetched: number;
  freshCount: number;
  techCount: number;
  scoredCount: number;
  clusteredCount: number;
};

/**
 * Pipeline pick candidates (curated, multi-stage):
 *
 *   1. fresh (≤ 48h)
 *   2. tech-relevant URL (path blacklist)
 *   3. tech-relevant title (keyword blacklist)
 *   4. arxiv stricter — bài arxiv không có signal AI key thì drop
 *   5. score everything (filter.keywordScore + score.scoreArticle)
 *   6. event clustering (Layer 3 dedup) — gom bài cùng sự kiện, giữ winner
 *   7. KV checks: chưa posted (URL hash), title chưa posted, không poison
 *   8. fuzzy dedup (Layer 2) — Jaccard ≥ 0.88 với recent 200 titles
 *   9. sort DESC theo score → trả top MAX_CANDIDATES_PER_RUN
 *
 * Caller (runBotInternal) sẽ chạy bucket selection trên list này.
 */
async function pickCandidates(env: Env, runId: string): Promise<PickResult> {
  console.log(`[bot:${runId}] Fetching ${RSS_SOURCES.length} RSS sources...`);
  const { articles, stats } = await fetchAllSources(RSS_SOURCES);
  console.log(`[bot:${runId}] Fetched ${articles.length} articles (top-N after sort)`);

  const fresh = articles.filter(isFresh);
  const techUrl = fresh.filter((a) => isTechRelevantUrl(a.link));
  const techTitle = techUrl.filter((a) => isTechRelevantTitle(a.title));

  // Stage arxiv stricter — chỉ áp dụng cho source arxiv
  const ARXIV_NAME = "arXiv cs.AI";
  const arxivPassed = techTitle.filter(
    (a) => a.source !== ARXIV_NAME || isRelevantArxivPaper(a.title),
  );
  const arxivDropped = techTitle.length - arxivPassed.length;

  console.log(
    `[bot:${runId}] Filter pipeline: total=${articles.length} fresh=${fresh.length} ` +
      `tech-url=${techUrl.length} tech-title=${techTitle.length} ` +
      `arxiv-strict-dropped=${arxivDropped} → ${arxivPassed.length}`,
  );

  if (arxivPassed.length === 0) {
    return {
      candidates: [],
      stats,
      totalFetched: articles.length,
      freshCount: fresh.length,
      techCount: techTitle.length,
      scoredCount: 0,
      clusteredCount: 0,
    };
  }

  // Score
  const now = new Date();
  for (const a of arxivPassed) {
    a.score = scoreArticle(a, now).total;
  }

  // Layer 3 dedup: cluster intra-batch
  const clustered = clusterBatch(arxivPassed);
  console.log(
    `[bot:${runId}] Event-clustering: ${arxivPassed.length} → ${clustered.length} ` +
      `(${arxivPassed.length - clustered.length} dropped as cluster losers)`,
  );

  // Sort DESC theo score
  clustered.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  // Layer 1 + Layer 2 dedup vs KV
  const recentTitles = await getRecentTitles(env);
  const candidates: Article[] = [];
  let skippedPosted = 0;
  let skippedTitlePosted = 0;
  let skippedPoison = 0;
  let skippedFuzzy = 0;

  for (const a of clustered) {
    if (await isPosted(env, a.link)) {
      skippedPosted++;
      continue;
    }
    if (await isTitlePosted(env, a.title)) {
      skippedTitlePosted++;
      continue;
    }
    const fc = await getFailCount(env, a.link);
    if (fc >= MAX_FAIL_BEFORE_SKIP) {
      skippedPoison++;
      continue;
    }
    const fuzzy = checkFuzzyDuplicate(a.title, recentTitles);
    if (fuzzy.duplicate) {
      skippedFuzzy++;
      console.log(
        `[bot:${runId}]   Fuzzy dup (${fuzzy.similarity.toFixed(2)}): "${a.title.slice(0, 80)}" ≈ "${fuzzy.similarTo.slice(0, 80)}"`,
      );
      continue;
    }
    candidates.push(a);
    if (candidates.length >= MAX_CANDIDATES_PER_RUN) break;
  }

  console.log(
    `[bot:${runId}] Eligible after dedup: ${candidates.length} ` +
      `(skipped: ${skippedPosted} url-posted, ${skippedTitlePosted} title-posted, ` +
      `${skippedPoison} poison, ${skippedFuzzy} fuzzy)`,
  );

  // Log top scoring candidates breakdown
  for (const a of candidates.slice(0, 3)) {
    console.log(
      `[bot:${runId}]   • [${a.sourceCategory}] ${formatBreakdown(scoreArticle(a, now))} — "${a.title.slice(0, 80)}" (${a.source})`,
    );
  }

  return {
    candidates,
    stats,
    totalFetched: articles.length,
    freshCount: fresh.length,
    techCount: techTitle.length,
    scoredCount: arxivPassed.length,
    clusteredCount: clustered.length,
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
 * Chọn candidate kế tiếp để thử, RE-CHECK bucket quota mỗi iteration.
 *
 * Lý do: nếu retry chỉ duyệt list đã sort 1 lần, có thể thử bài từ bucket đầy
 * trong khi bucket khác còn slot → vi phạm quota. Bằng cách selectFromBuckets
 * lại trên `remaining` (đã trừ tried), mỗi lần retry vẫn ưu tiên bucket-eligible
 * trước khi rơi vào fallback.
 *
 * Returns null khi không còn candidate nào chưa thử.
 */
function nextCandidateToTry(
  candidates: readonly Article[],
  tried: ReadonlySet<Article>,
  usage: Record<SourceCategory, number>,
): { article: Article; fallback: boolean; pickedFrom: SourceCategory | "fallback" } | null {
  const remaining = candidates.filter((c) => !tried.has(c));
  if (remaining.length === 0) return null;
  const sel = selectFromBuckets(remaining, usage, DEFAULT_QUOTA);
  if (!sel.picked) return null;
  return {
    article: sel.picked,
    fallback: sel.fallback,
    pickedFrom: sel.pickedFrom ?? "fallback",
  };
}

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
          : "all candidates đã đăng / poison / dup";
    console.warn(`[bot:${runId}] No candidate to try. Reason: ${reason}`);
    return { runId, posted: false, attempted: 0, reason };
  }

  // ───── Bucket selection — chọn theo quota ngày ─────
  const dayKey = todayKeyUTC();
  const usage = await getAllUsage(env, dayKey);
  console.log(`[bot:${runId}] Bucket usage today (${dayKey}): ${formatUsage(usage)}`);

  // Retry loop: mỗi iteration RE-CHECK bucket quota để chọn next candidate.
  // Đảm bảo nếu candidate đầu fail, candidate tiếp theo vẫn ưu tiên bucket
  // còn slot — không vô tình post từ bucket đầy khi còn bucket trống.
  const tried = new Set<Article>();
  // Circuit breaker (Phase 9.1): provider nào đã fatal (429/401/403) trong run
  // này sẽ bị skip cho các article kế tiếp → tiết kiệm HTTP call khi quota cạn.
  // Reset cho mỗi run vì giữa các tick (1h) quota có thể đã được restore.
  const deadProviders = new Set<string>();
  let fallbackWarned = false;
  let attempts = 0;
  const total = pick.candidates.length;

  while (true) {
    const next = nextCandidateToTry(pick.candidates, tried, usage);
    if (!next) break;
    tried.add(next.article);
    attempts++;

    if (next.fallback && !fallbackWarned) {
      console.warn(
        `[bot:${runId}] All buckets full for today — fallback: chọn highest score chung. ` +
          `Usage: ${formatUsage(usage)}`,
      );
      fallbackWarned = true;
    }

    const article = next.article;
    const tag = `[bot:${runId}] (${attempts}/${total})`;
    console.log(
      `${tag} Trying [${next.pickedFrom}${next.fallback ? ", fallback" : ""}]: ` +
        `"${article.title}" — ${article.source} [score=${article.score ?? 0}]`,
    );
    console.log(`${tag}   Link: ${article.link}`);

    // Re-check posted ngay trước khi reserve — phòng race với 1 cron khác
    // (vd manual /run trong khi cron đang chạy).
    if (await isPosted(env, article.link)) {
      console.log(`${tag}   Race detected: bài đã được claim bởi run khác. Skip.`);
      continue;
    }

    // ───── Bước 1: AI summarize (chain fallback Gemini → OpenRouter) ─────
    let summary;
    let aiProvider = "unknown";
    try {
      console.log(`${tag}   Summarizing (AI provider chain)...`);
      const result = await summarizeArticle(article, env, deadProviders);
      summary = result.summary;
      aiProvider = result.provider;
      console.log(`${tag}   [provider=${aiProvider}] Title: ${summary.title}`);
    } catch (err) {
      const fc = await incrementFailCount(env, article.link).catch(() => -1);
      console.error(
        `${tag}   AI fail (count→${fc}): ${(err as Error).message?.slice(0, 400)}`,
      );
      continue; // thử bài tiếp theo
    }

    if (dry) {
      console.log(`${tag}   DRY RUN — would post: "${summary.title}" [provider=${aiProvider}]`);
      return {
        runId,
        posted: false,
        attempted: attempts,
        postedTitle: summary.title,
        postedSource: article.source,
        postedLink: article.link,
        reason: `dry-run (provider=${aiProvider})`,
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

      // Best-effort book-keeping. Lỗi từng bước KHÔNG được throw — bài đã
      // post lên Telegram thành công thì run này phải coi là success.
      await markTitlePosted(env, article.title).catch((e) =>
        console.error(`${tag}   markTitlePosted failed: ${(e as Error).message}`),
      );
      await pushRecentTitle(env, article.title).catch((e) =>
        console.error(`${tag}   pushRecentTitle failed: ${(e as Error).message}`),
      );
      await incrementCategoryUsage(env, article.sourceCategory, dayKey).catch((e) =>
        console.error(`${tag}   incrementCategoryUsage failed: ${(e as Error).message}`),
      );
      await setLastPosted(env, {
        title: summary.title,
        source: article.source,
        link: article.link,
        category: article.sourceCategory,
        score: article.score ?? 0,
        postedAt: new Date().toISOString(),
        provider: aiProvider,
      }).catch((e) =>
        console.error(`${tag}   setLastPosted failed: ${(e as Error).message}`),
      );

      console.log(
        `${tag}   ✅ Posted successfully. [${article.sourceCategory}, score=${article.score ?? 0}, provider=${aiProvider}]`,
      );
      return {
        runId,
        posted: true,
        attempted: attempts,
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
    `[bot:${runId}] Tried ${attempts}/${total} candidates, none succeeded.`,
  );
  return {
    runId,
    posted: false,
    attempted: attempts,
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

    // ───── /stats: bucket usage hôm nay + tổng posts (cần auth) ─────
    if (url.pathname === "/stats") {
      if (!isAuthorized(req, env)) {
        return new Response("Unauthorized\n", { status: 401 });
      }
      const dayKey = todayKeyUTC();
      const usage = await getAllUsage(env, dayKey);
      const totalToday =
        usage.core + usage.ai + usage.dev + usage.research + usage.trend;
      const totalQuota =
        DEFAULT_QUOTA.core +
        DEFAULT_QUOTA.ai +
        DEFAULT_QUOTA.dev +
        DEFAULT_QUOTA.research +
        DEFAULT_QUOTA.trend;
      const recent = await getRecentTitles(env);
      const body = {
        dayKey,
        usage,
        quota: DEFAULT_QUOTA,
        totalToday,
        totalQuota,
        usageStr: formatUsage(usage),
        recentTitlesCount: recent.length,
        recentTitlesPreview: recent.slice(0, 10).map((r) => ({
          raw: r.raw,
          postedAt: r.postedAt,
        })),
        checkedAt: new Date().toISOString(),
      };
      return new Response(JSON.stringify(body, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ───── /last: snapshot bài đăng gần nhất (cần auth) ─────
    if (url.pathname === "/last") {
      if (!isAuthorized(req, env)) {
        return new Response("Unauthorized\n", { status: 401 });
      }
      const last = await getLastPosted(env);
      if (!last) {
        return new Response(
          JSON.stringify({ message: "Chưa có bài nào được đăng (KV empty)." }, null, 2),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify(last, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ───── /top_today: top 10 candidate eligible NGAY BÂY GIỜ (cần auth) ─────
    // Phase 13: dùng để debug "vì sao bài X không được chọn?" — chạy full pipeline
    // (fetch + filter + score + dedup) nhưng KHÔNG post, trả về top 10 bài score
    // cao nhất cùng breakdown chi tiết để diagnostic.
    if (url.pathname === "/top_today") {
      if (!isAuthorized(req, env)) {
        return new Response("Unauthorized\n", { status: 401 });
      }
      const runId = shortRunId();
      try {
        const pick = await pickCandidates(env, runId);
        const now = new Date();
        const top = pick.candidates.slice(0, 10).map((a) => ({
          title: a.title,
          source: a.source,
          category: a.sourceCategory,
          priority: a.sourcePriority,
          link: a.link,
          pubDate: a.pubDate.toISOString(),
          score: a.score,
          breakdown: scoreArticle(a, now),
        }));
        const body = {
          runId,
          totalFetched: pick.totalFetched,
          freshCount: pick.freshCount,
          techCount: pick.techCount,
          scoredCount: pick.scoredCount,
          clusteredCount: pick.clusteredCount,
          eligibleCount: pick.candidates.length,
          top,
          checkedAt: new Date().toISOString(),
        };
        return new Response(JSON.stringify(body, null, 2), {
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

    // ───── /run: manual trigger (cần auth) ─────
    // Alias /force_fetch (Phase 13) — cùng logic, tên khác cho admin tiện gọi.
    if (url.pathname === "/run" || url.pathname === "/force_fetch") {
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
        "Endpoints (Bearer = cần Authorization: Bearer <RUN_TRIGGER_TOKEN>):\n" +
        "  GET  /health                  — ping\n" +
        "  POST /run (Bearer)            — trigger ngay (async)\n" +
        "  POST /run?dry=1 (Bearer)      — dry-run, trả về candidate sẽ chọn (KHÔNG post)\n" +
        "  POST /force_fetch (Bearer)    — alias của /run\n" +
        "  GET  /sources   (Bearer)      — source health report\n" +
        "  GET  /stats     (Bearer)      — bucket usage hôm nay + recent titles\n" +
        "  GET  /last      (Bearer)      — snapshot bài đăng gần nhất\n" +
        "  GET  /top_today (Bearer)      — top 10 candidate eligible + score breakdown\n",
      { status: 200, headers: { "Content-Type": "text/plain" } },
    );
  },
} satisfies ExportedHandler<Env>;
