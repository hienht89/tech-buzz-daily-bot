import {
  RSS_SOURCES,
  isTechRelevantUrl,
  isTechRelevantTitle,
  type SourceCategory,
} from "./sources.js";
import { fetchAllSources, type Article, type SourceStat } from "./rss.js";
import { summarizeArticle, getProviders } from "./ai.js";
import {
  probeProviders,
  probeKvRoundTrip,
  runKvOps,
  summarizeKvResults,
  type KvOpResult,
} from "./diag.js";
import { postArticle, sendAdminAlert } from "./telegram.js";
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
  pushScoreHistory,
  getScoreHistory,
  MAX_FAIL_BEFORE_SKIP,
} from "./storage.js";
import {
  computeDynamicThreshold,
  percentileOf,
  FALLBACK_THRESHOLD,
  MIN_CLAMP as THRESHOLD_MIN_CLAMP,
  MAX_CLAMP as THRESHOLD_MAX_CLAMP,
  DEFAULT_PERCENTILE as THRESHOLD_DEFAULT_PERCENTILE,
  MIN_HISTORY_FOR_DYNAMIC,
} from "./threshold.js";
import {
  incrementSkippedSlotCount,
  getSkippedSlotCount,
  wasAdminAlertSent,
  markAdminAlertSent,
} from "./skipCounter.js";

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
  /**
   * Chat ID nhận cảnh báo Telegram (admin DM hoặc channel test).
   *
   * Phase 19.6: KHÔNG còn dùng cho cảnh báo "skipped slot" (đã bỏ skip-low-score
   * gate). Vẫn giữ để có thể tái sử dụng cho các alert tương lai (vd AI dead).
   *
   * Có thể là DM admin (số dương, vd `123456789`) hoặc 1 channel test riêng
   * (vd `@my_admin_alerts` / `-100123…`).
   *
   * KHÔNG set → tắt mọi cảnh báo. Đặt qua `wrangler secret put TELEGRAM_ADMIN_CHAT_ID`.
   */
  TELEGRAM_ADMIN_CHAT_ID?: string;
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
 *
 * Phase 18 (Apr 29 2026): giảm 5 → 3 để giới hạn worst-case latency mỗi run.
 * Với circuit breaker mạnh hơn (408 fatal + 5xx-repeat mark dead), provider
 * chậm chết sớm → ít cần buffer 5 candidate. 3 candidate vẫn dư cho retry
 * khi 1-2 bài fail Telegram/AI.
 */
const MAX_CANDIDATES_PER_RUN = 3;

/**
 * Threshold điểm — TÍNH ĐỘNG nhưng CHỈ DÙNG ĐỂ HIỂN THỊ (Phase 19.6, Apr 30 2026).
 *
 * Lịch sử:
 *   - Phase 15 (Apr 28 2026): khởi đầu hard-code = 220, dùng làm gate skip.
 *   - Phase 18 (Apr 29 2026): hạ 220 → 190.
 *   - Task 7 (Apr 2026): bỏ hard-code, tính động từ percentile của score history.
 *   - Phase 19.5 (Apr 30 2026): tuning constants — fallback 195, p25, MIN_CLAMP 170.
 *   - Phase 19.6 (Apr 30 2026): GỠ vai trò gate. User yêu cầu 18 bài/ngày
 *     guarantee → không skip slot vì score thấp nữa. Threshold vẫn được tính
 *     mỗi tick để hiển thị ở /stats và đếm informational "below threshold" trong
 *     log, nhưng KHÔNG ảnh hưởng decision có post hay không.
 *
 * Cách bot chọn bài (Phase 19.6):
 *   1. Filter pipeline (tech URL + tech title + arxiv strict + dedup) — vẫn nguyên.
 *   2. Tất cả bài qua filter đều thành candidate (không gate score nữa).
 *   3. Bucket selection chọn highest-score trong bucket còn quota; nếu mọi bucket
 *      đầy → fallback highest-score chung.
 *   4. Mỗi tick → đăng đúng 1 bài.
 *
 * Threshold hiển thị: /stats trả về threshold hiện tại + p20/p40/p60 + history
 * count để admin theo dõi distribution score đang post. Xem `worker/src/threshold.ts`.
 */

/**
 * [DEPRECATED Phase 19.6] Số slot/ngày bị skip do "all candidates below threshold" trước
 * khi gửi cảnh báo Telegram cho admin (Task 6, Apr 2026).
 *
 * Phase 19.6: KHÔNG còn được gọi. Constant giữ lại để tương thích với type +
 * tránh xóa skipCounter.ts (vẫn có thể bật lại sau nếu cần monitoring).
 */
const SKIP_ALERT_THRESHOLD = 3;

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
  /**
   * Số bài có score < threshold động (informational, Phase 19.6 KHÔNG còn skip
   * vì lý do này — chỉ đếm để hiển thị distribution).
   */
  skippedLowScore: number;
  /** Threshold động đã tính (chỉ informational từ Phase 19.6) — bubble lên để log/response. */
  minScoreThreshold: number;
  /**
   * Top 10 article PRE-bucket (sau cluster + dedup, trước bucket selection).
   * Dùng để diagnostic distribution score / so sánh với what-was-posted.
   * Phase 19.6: không còn "pre-gate" vì threshold gate đã bỏ — đổi tên ngữ nghĩa
   * thành "top sau dedup" trong log/UI.
   */
  topPreGate: Article[];
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
async function pickCandidates(
  env: Env,
  runId: string,
  minScoreThreshold: number,
): Promise<PickResult> {
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
      skippedLowScore: 0,
      minScoreThreshold,
      topPreGate: [],
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

  // Layer 1 + Layer 2 dedup vs KV + min-score gate
  const recentTitles = await getRecentTitles(env);
  const candidates: Article[] = [];
  let skippedPosted = 0;
  let skippedTitlePosted = 0;
  let skippedPoison = 0;
  let skippedFuzzy = 0;
  let skippedLowScore = 0;

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
    // Phase 19.6: bỏ min-score gate. Triết lý mới "always-post" — luôn cố
    // post bài tốt nhất hiện có, không bỏ slot vì score thấp. Threshold vẫn
    // được tính ra (cho /stats hiển thị + đếm informational dưới đây) nhưng
    // KHÔNG dùng để skip. Bài vẫn qua 4 lớp filter trước (tech URL + tech
    // title + arxiv strict + dedup) nên không có rủi ro post bài rác.
    if ((a.score ?? 0) < minScoreThreshold) {
      skippedLowScore++; // chỉ để log/diagnostic, không skip
    }
    candidates.push(a);
    if (candidates.length >= MAX_CANDIDATES_PER_RUN) break;
  }

  console.log(
    `[bot:${runId}] Eligible after dedup: ${candidates.length} ` +
      `(skipped: ${skippedPosted} url-posted, ${skippedTitlePosted} title-posted, ` +
      `${skippedPoison} poison, ${skippedFuzzy} fuzzy; ` +
      `${skippedLowScore} below threshold ${minScoreThreshold} [informational, KHÔNG skip])`,
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
    skippedLowScore,
    minScoreThreshold,
    topPreGate: clustered.slice(0, 10),
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
  /**
   * Phase 17 (P0-C): kết quả từng KV book-keeping write SAU khi Telegram
   * publish thành công. Bubble lên RunResult để admin curl /run thấy ngay
   * write nào fail (không phải mò log). Undefined nếu run không post được
   * (vd dry-run, all candidates fail).
   */
  kvWrites?: KvOpResult[];
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
 * Tăng counter slot bị skip do "all candidates below MIN_SCORE_THRESHOLD" cho
 * ngày hôm nay. Gửi Telegram alert tối đa 1 lần / ngày (set flag KV
 * `skipped_alert_sent:YYYY-MM-DD` SAU khi gửi thành công).
 *
 * Khác với "fire khi count === threshold": dùng `count >= threshold AND
 * !alreadySent`. Nếu Telegram transient down ĐÚNG tick count đạt 3, tick sau
 * (count=4) sẽ thử lại — không miss alert vĩnh viễn.
 *
 * Tách thành function riêng vì:
 *  - Có 2 path lỗi cần handle khác nhau (KV write fail vs Telegram fail) và
 *    cả hai phải được catch để KHÔNG ảnh hưởng pipeline chính (slot quan trọng
 *    hơn alert).
 *  - Dễ kiểm tra logic bằng mắt mà không phải đọc cả `runBotInternal` dài hàng
 *    trăm dòng.
 *
 * Trả về newCount (số slot skip sau khi tăng) để caller log; trả 0 nếu KV
 * write fail (counter chưa tăng, alert sẽ thử lại tick sau).
 */
async function maybeAlertSkippedSlot(
  env: Env,
  runId: string,
  skippedLowScore: number,
  minScoreThreshold: number,
): Promise<number> {
  const dayKey = todayKeyUTC();
  let newCount: number;
  try {
    newCount = await incrementSkippedSlotCount(env.POSTED_KV, dayKey);
  } catch (err) {
    console.error(
      `[bot:${runId}] Skip-counter KV write fail: ` +
        `${(err as Error).message?.slice(0, 200)}. Alert delayed.`,
    );
    return 0;
  }
  console.log(
    `[bot:${runId}] Skipped slot counter today (${dayKey}): ` +
      `${newCount} (alert threshold = ${SKIP_ALERT_THRESHOLD})`,
  );

  if (newCount < SKIP_ALERT_THRESHOLD) {
    return newCount;
  }
  if (!env.TELEGRAM_ADMIN_CHAT_ID) {
    console.log(
      `[bot:${runId}] Counter ≥ threshold nhưng TELEGRAM_ADMIN_CHAT_ID ` +
        `không set → bỏ qua alert.`,
    );
    return newCount;
  }

  // Check flag: nếu hôm nay đã alert thành công 1 lần rồi → silent (tick 4,5,..
  // không spam). KV read fail → giả định CHƯA gửi để safe-side (admin có thể
  // bị duplicate alert thay vì miss).
  let alreadySent = false;
  try {
    alreadySent = await wasAdminAlertSent(env.POSTED_KV, dayKey);
  } catch (err) {
    console.error(
      `[bot:${runId}] Read alert-sent flag fail (assume not sent): ` +
        `${(err as Error).message?.slice(0, 200)}`,
    );
  }
  if (alreadySent) {
    return newCount;
  }

  const text =
    `⚠️ <b>Tech Buzz Daily — cảnh báo chất lượng</b>\n\n` +
    `Hôm nay (${dayKey}, UTC) bot đã <b>bỏ qua ${newCount} slot</b> vì không có bài nào ` +
    `score ≥ <b>${minScoreThreshold}</b> (threshold động — Task 7).\n\n` +
    `Tick gần nhất có ${skippedLowScore} bài bị skip do score thấp.\n\n` +
    `Có thể do nguồn RSS hôm nay yếu, hoặc threshold động đang bám p25 history ở mức ` +
    `cao. Kiểm tra <code>/stats</code> xem threshold hiện tại + p20/p40/p60 và ` +
    `<code>/top_today</code> xem điểm thực tế của batch.`;
  const sent = await sendAdminAlert(env, text);
  if (sent) {
    console.log(
      `[bot:${runId}] ✅ Đã gửi cảnh báo skipped-slot tới admin (count=${newCount}).`,
    );
    // Set flag chỉ KHI gửi thành công. Nếu set fail → tick sau có thể gửi lại
    // (admin nhận duplicate) — chấp nhận được vì hiếm + không miss thông tin.
    try {
      await markAdminAlertSent(env.POSTED_KV, dayKey);
    } catch (err) {
      console.error(
        `[bot:${runId}] Set alert-sent flag fail (next tick may resend): ` +
          `${(err as Error).message?.slice(0, 200)}`,
      );
    }
  } else {
    console.log(
      `[bot:${runId}] ⚠️ Gửi cảnh báo skipped-slot FAIL (count=${newCount}). ` +
        `Sẽ thử lại tick sau.`,
    );
  }
  return newCount;
}

/**
 * Đọc score history từ KV → tính threshold động (Task 7).
 *
 * KV read fail (vd binding tạm down, transient 5xx) KHÔNG bao giờ làm runBot
 * crash — fallback về `FALLBACK_THRESHOLD` (xem threshold.ts để biết giá trị
 * hiện tại). Bot có thể chạy "blind" 1 tick còn hơn skip vì lỗi cơ sở hạ tầng.
 *
 * Tách thành function riêng để: (a) tái sử dụng được trong endpoint /stats và
 * /top_today, (b) test được mà không phải mock cả runBotInternal.
 */
async function resolveDynamicThreshold(env: Env, runId: string): Promise<number> {
  let history;
  try {
    history = await getScoreHistory(env);
  } catch (err) {
    console.error(
      `[bot:${runId}] Đọc score_history_v1 fail (${(err as Error).message?.slice(0, 200)}). ` +
        `Fallback threshold ${FALLBACK_THRESHOLD}.`,
    );
    return FALLBACK_THRESHOLD;
  }
  const threshold = computeDynamicThreshold(history);
  const isFallback = history.length < MIN_HISTORY_FOR_DYNAMIC;
  const pctLabel = `p${Math.round(THRESHOLD_DEFAULT_PERCENTILE * 100)}`;
  console.log(
    `[bot:${runId}] Dynamic threshold = ${threshold} ` +
      `(history=${history.length}, ${isFallback ? "FALLBACK (cold start)" : pctLabel + " clamped to [" + THRESHOLD_MIN_CLAMP + "," + THRESHOLD_MAX_CLAMP + "]"})`,
  );
  return threshold;
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

  // Task 7: tự dò threshold động từ score history. KV read fail → fallback
  // (tránh để 1 KV hiccup làm cả run đứng).
  const minScoreThreshold = await resolveDynamicThreshold(env, runId);

  const pick = await pickCandidates(env, runId, minScoreThreshold);

  if (pick.candidates.length === 0) {
    // Phase 19.6: bỏ branch "all below MIN_SCORE_THRESHOLD" vì threshold không
    // còn gate nữa. Giờ candidates=0 chỉ xảy ra do nguyên nhân kỹ thuật/data:
    // RSS chết, không có bài fresh, không bài nào qua tech filter, hoặc tất
    // cả đã đăng/poison/dup.
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
  // Phase 16 diagnostic: ghi nhớ lỗi cuối cùng để bubble lên `reason` field —
  // trước đây dry-run chỉ trả "all candidates failed" mà không nói lỗi gì,
  // làm khó debug khi quota Gemini cạn (vd today: 18 tick × N candidate đều
  // fail vì free-tier 429, KV không bao giờ được ghi → /stats vẫn báo 0/18).
  let lastAiError: string | undefined;
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
      const msg = (err as Error).message?.slice(0, 400) ?? "unknown";
      lastAiError = msg;
      console.error(`${tag}   AI fail (count→${fc}): ${msg}`);
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
      console.log(`${tag}   ✓ Telegram publish OK`);

      // ───── Bước 3.5: Book-keeping KV writes (Phase 17 — P0-C) ─────
      // 5 write song song qua Promise.allSettled → KHÔNG nuốt lỗi mơ hồ:
      // log per-op status + ms, bubble kết quả lên RunResult để admin curl
      // thấy ngay write nào fail. Bài đã lên Telegram → bot LUÔN coi là
      // success dù 1-2 write phụ fail (slot không bị mất).
      //
      // Lý do refactor: trước đây 4 `.catch(log)` tuần tự → khi quota AI
      // chết, không ai thấy là KV cũng có thể đang fail. Giờ /run trả về
      // kvWrites[] luôn, không cần wrangler tail.
      const lastPostedPayload = {
        title: summary.title,
        source: article.source,
        link: article.link,
        category: article.sourceCategory,
        score: article.score ?? 0,
        postedAt: new Date().toISOString(),
        provider: aiProvider,
      };
      const kvWrites = await runKvOps([
        { name: "clearFailCount", op: () => clearFailCount(env, article.link) },
        { name: "markTitlePosted", op: () => markTitlePosted(env, article.title) },
        { name: "pushRecentTitle", op: () => pushRecentTitle(env, article.title) },
        {
          name: "incrementCategoryUsage",
          op: () => incrementCategoryUsage(env, article.sourceCategory, dayKey),
        },
        { name: "setLastPosted", op: () => setLastPosted(env, lastPostedPayload) },
        // Task 7: feed score vào history để threshold tự thích nghi tick sau.
        // Pass NaN khi score undefined → pushScoreHistory tự skip (no-op),
        // tránh ô nhiễm history bằng 0 giả tạo.
        {
          name: "pushScoreHistory",
          op: () => pushScoreHistory(env, article.score ?? Number.NaN),
        },
      ]);
      const sum = summarizeKvResults(kvWrites);
      if (sum.failCount === 0) {
        console.log(`${tag}   📝 KV book-keeping ${sum.statusLine}`);
      } else {
        console.error(`${tag}   ⚠️ KV book-keeping ${sum.statusLine}`);
        console.error(`${tag}   ⚠️ ${sum.failDetail}`);
      }

      console.log(
        `${tag}   ✅ Posted successfully. [${article.sourceCategory}, ` +
          `score=${article.score ?? 0}, provider=${aiProvider}, ` +
          `kvWrites=${sum.okCount}/${kvWrites.length}]`,
      );
      return {
        runId,
        posted: true,
        attempted: attempts,
        postedTitle: summary.title,
        postedSource: article.source,
        postedLink: article.link,
        kvWrites,
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
    `[bot:${runId}] Tried ${attempts}/${total} candidates, none succeeded.` +
      (lastAiError ? ` Last AI error: ${lastAiError}` : ""),
  );
  return {
    runId,
    posted: false,
    attempted: attempts,
    // Phase 16: bubble lastAiError lên `reason` để dry-run/admin curl thấy
    // ngay nguyên nhân thực sự (vd "All AI providers failed. Errors: gemini-2.5-flash#k0: HTTP 429 ...")
    // mà không cần phải mở wrangler tail.
    reason: lastAiError
      ? `all candidates failed — lastAiError: ${lastAiError}`
      : "all candidates failed",
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
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const startedAt = new Date().toISOString();
    // Phase 17: log cron meta (cron expression + scheduled time) để admin
    // distinguish "cron không fire" vs "cron fire nhưng pipeline fail".
    console.log(
      `[bot] Cron triggered at ${startedAt} (UTC). cronExpr=${controller.cron} ` +
        `scheduledTime=${new Date(controller.scheduledTime).toISOString()}`,
    );
    ctx.waitUntil(
      runBot(env)
        .then((result) => {
          // Echo final decision lên log để cron-only run cũng có summary 1 dòng
          // (trước đây chỉ /run mới thấy RunResult).
          console.log(
            `[bot:${result.runId}] Cron run finished. posted=${result.posted} ` +
              `attempted=${result.attempted}` +
              (result.postedTitle ? ` title="${result.postedTitle.slice(0, 80)}"` : "") +
              (result.reason ? ` reason="${result.reason.slice(0, 200)}"` : "") +
              (result.kvWrites
                ? ` kvWrites=${result.kvWrites.filter((k) => k.ok).length}/${result.kvWrites.length}`
                : ""),
          );
        })
        .catch((err) => {
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
      const skippedSlotCount = await getSkippedSlotCount(env.POSTED_KV, dayKey);

      // Task 7: dynamic threshold + percentile snapshot. Đọc lại history (KV
      // read rẻ — 1 entry JSON ~10KB max) thay vì cache: đảm bảo /stats luôn
      // phản ánh đúng KV hiện tại, không bị stale do cron tick chưa fire.
      const scoreHistory = await getScoreHistory(env);
      const scores = scoreHistory.map((e) => e.score);
      const currentThreshold = computeDynamicThreshold(scoreHistory);
      const isFallback = scoreHistory.length < MIN_HISTORY_FOR_DYNAMIC;
      const thresholdInfo = {
        current: currentThreshold,
        mode: isFallback ? ("fallback" as const) : ("dynamic" as const),
        fallback: FALLBACK_THRESHOLD,
        clamp: { min: THRESHOLD_MIN_CLAMP, max: THRESHOLD_MAX_CLAMP },
        percentile: THRESHOLD_DEFAULT_PERCENTILE,
        minHistoryForDynamic: MIN_HISTORY_FOR_DYNAMIC,
        historyCount: scoreHistory.length,
        // Round percentile values cho dễ đọc — full float vô nghĩa với điểm
        // nguyên (score luôn nguyên).
        p20: scores.length > 0 ? Math.round(percentileOf(scores, 0.2)) : null,
        p40: scores.length > 0 ? Math.round(percentileOf(scores, 0.4)) : null,
        p60: scores.length > 0 ? Math.round(percentileOf(scores, 0.6)) : null,
      };

      const body = {
        dayKey,
        usage,
        quota: DEFAULT_QUOTA,
        totalToday,
        totalQuota,
        usageStr: formatUsage(usage),
        // [DEPRECATED Phase 19.6] Counter cũ cho slot bị skip do score thấp.
        // Từ Phase 19.6 luôn = 0 vì bot không còn skip slot. Giữ trong response
        // để admin cũ không bị broken-field; sẽ xóa sau vài ngày verify ổn định.
        skippedSlotCount,
        skippedSlotAlertThreshold: SKIP_ALERT_THRESHOLD,
        // Task 7: threshold động + phân phối p20/p40/p60 + history count.
        threshold: thresholdInfo,
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
        // Task 7: dùng cùng dynamic threshold như runBotInternal — endpoint
        // này phải trả về CHÍNH XÁC kết quả pickCandidates sẽ làm khi cron
        // chạy ngay bây giờ (thay vì áp ngưỡng cố định cũ).
        const minScoreThreshold = await resolveDynamicThreshold(env, runId);
        const pick = await pickCandidates(env, runId, minScoreThreshold);
        const now = new Date();
        const mapArticle = (a: Article) => ({
          title: a.title,
          source: a.source,
          category: a.sourceCategory,
          priority: a.sourcePriority,
          link: a.link,
          pubDate: a.pubDate.toISOString(),
          score: a.score,
          breakdown: scoreArticle(a, now),
        });
        const top = pick.candidates.slice(0, 10).map(mapArticle);
        // Phase 16 diagnostic: top 10 PRE-gate (trước threshold + KV check).
        // Cho phép admin nhìn thấy điểm thực tế của batch hiện tại → chỉnh
        // history nếu eligibleCount=0 do threshold quá cao.
        const topPreGate = pick.topPreGate.map(mapArticle);
        const body = {
          runId,
          totalFetched: pick.totalFetched,
          freshCount: pick.freshCount,
          techCount: pick.techCount,
          scoredCount: pick.scoredCount,
          clusteredCount: pick.clusteredCount,
          eligibleCount: pick.candidates.length,
          minScoreThreshold,
          skippedLowScore: pick.skippedLowScore,
          top,
          topPreGate,
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

    // ───── /diag_ai: probe từng AI provider riêng lẻ (cần auth) ─────
    // Phase 16 diagnostic: gọi mỗi provider trong getProviders(env) trên 1
    // article giả tí xíu, KHÔNG đụng KV / Telegram / RSS pipeline. Trả về
    // {provider, ok, error} cho từng cái — dùng để confirm "Gemini hết quota,
    // OpenRouter có cứu được không?" mà không cần đợi cron tick.
    //
    // Latency: chạy SEQUENTIAL (không parallel) → tốn ~latency mỗi provider
    // cộng dồn. Khi tất cả thành công, mỗi provider ~1-3s nên tổng ~10-20s
    // cho 6 provider. Khi fail nhanh (HTTP 4xx ngay) thì <1s/provider.
    // Khi 1 provider treo, có thể chạm timeout 30s mặc định. Acceptable cho
    // admin diagnostic — KHÔNG nên gắn vào health check tự động.
    if (url.pathname === "/diag_ai") {
      if (!isAuthorized(req, env)) {
        return new Response("Unauthorized\n", { status: 401 });
      }
      const fakeArticle: Article = {
        title: "Test ping article for AI provider health check",
        link: "https://example.com/diag",
        canonicalUrl: "https://example.com/diag",
        pubDate: new Date(),
        contentSnippet:
          "This is a tiny ping article used to check if AI providers respond. " +
          "OpenAI announced something. The system works. End of test content.",
        source: "diag",
        sourceCategory: "core",
        sourcePriority: 1,
      };
      const providers = getProviders(env);
      const results = await probeProviders(providers, fakeArticle);
      return new Response(
        JSON.stringify(
          {
            providerCount: providers.length,
            results,
            checkedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // ───── /debug_kv: round-trip probe KV namespace (cần auth) ─────
    // Phase 17 (P1): write key tạm 60s TTL → read back → delete. Trả về
    // per-op latency + matched. Mục đích: xác minh ngay binding POSTED_KV
    // production có ghi/đọc thực sự được không, mà không cần phải đợi 1 cron
    // tick rồi grep wrangler tail.
    //
    // Eventual consistency: KV cache edge có thể chưa thấy write ngay → `get`
    // có thể trả null (matched=false) dù `put.ok=true`. Đó vẫn là tín hiệu
    // KV nhận write OK (binding sống). Chỉ alarm khi `put.ok=false`.
    if (url.pathname === "/debug_kv") {
      if (!isAuthorized(req, env)) {
        return new Response("Unauthorized\n", { status: 401 });
      }
      const testKey = `__diag_kv:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
      const testValue = JSON.stringify({
        nonce: crypto.randomUUID(),
        writtenAt: new Date().toISOString(),
      });
      const ops = await probeKvRoundTrip(env.POSTED_KV, testKey, testValue);
      const putOp = ops.find((o) => o.op === "put");
      const getOp = ops.find((o) => o.op === "get");
      const allOk = ops.every((o) => o.ok);
      const summary = !putOp?.ok
        ? "❌ KV PUT failed — binding broken hoặc namespace mismatch"
        : getOp && getOp.ok && getOp.matched === false
          ? "⚠️ KV PUT OK nhưng GET trả null/khác — eventual consistency, " +
            "thử lại sau vài giây nếu cần verify chắc"
          : allOk
            ? "✅ KV round-trip OK"
            : "⚠️ Một vài op fail — xem chi tiết";
      return new Response(
        JSON.stringify(
          {
            kvBinding: "POSTED_KV",
            testKey,
            ops,
            summary,
            checkedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        {
          status: putOp?.ok ? 200 : 500,
          headers: { "Content-Type": "application/json" },
        },
      );
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
        "  GET  /stats     (Bearer)      — bucket usage hôm nay + threshold động (Task 7) + recent titles\n" +
        "  GET  /last      (Bearer)      — snapshot bài đăng gần nhất\n" +
        "  GET  /top_today (Bearer)      — top 10 candidate sau filter+dedup (Phase 19.6: không còn gate threshold)\n" +
        "  GET  /diag_ai   (Bearer)      — Phase 16: probe từng AI provider, trả {provider, ok, ms, error}\n" +
        "  GET  /debug_kv  (Bearer)      — Phase 17: round-trip POSTED_KV (put→get→delete) verify binding sống\n",
      { status: 200, headers: { "Content-Type": "text/plain" } },
    );
  },
} satisfies ExportedHandler<Env>;
