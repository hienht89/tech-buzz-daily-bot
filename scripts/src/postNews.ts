import {
  RSS_SOURCES,
  isTechRelevantUrl,
  isTechRelevantTitle,
} from "./lib/sources.js";
import { fetchAllSources, type Article } from "./lib/rss.js";
import { getPostedUrls, markPosted } from "./lib/storage.js";
import { summarizeArticle } from "./lib/ai.js";
import { postArticle } from "./lib/telegram.js";

const MAX_AGE_HOURS = 48;
const MAX_SLEEP_MS = 30 * 60 * 1000; // tối đa chờ 30 phút

function nextEvenUtcHour(now: Date): Date {
  const target = new Date(now);
  target.setUTCMinutes(0, 0, 0);
  let h = now.getUTCHours() + 1;
  while (h % 2 !== 0) h += 1;
  target.setUTCHours(h);
  return target;
}

async function sleepUntilTarget(): Promise<void> {
  // Chỉ đồng bộ với mốc giờ khi chạy theo lịch (cron). Manual trigger → đăng ngay.
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (eventName && eventName !== "schedule") {
    console.log(
      `[bot] Event="${eventName}" (không phải cron) — đăng ngay không chờ.`,
    );
    return;
  }

  const now = new Date();
  const target = nextEvenUtcHour(now);
  const waitMs = target.getTime() - now.getTime();
  const targetVn = new Date(target.getTime() + 7 * 3600 * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);

  if (waitMs > 0 && waitMs <= MAX_SLEEP_MS) {
    console.log(
      `[bot] Đợi ${Math.round(waitMs / 1000)}s tới mốc ${targetVn} (giờ VN) rồi đăng...`,
    );
    await new Promise((r) => setTimeout(r, waitMs));
    console.log(`[bot] Đến giờ! Bắt đầu đăng.`);
  } else if (waitMs > MAX_SLEEP_MS) {
    console.log(
      `[bot] Quá sớm so với mốc giờ kế (${targetVn} VN, còn ${Math.round(waitMs / 60000)}m) — đăng luôn.`,
    );
  } else {
    // Đã quá mốc giờ trước đó — GitHub Actions trễ. Đăng luôn để không bỏ lỡ slot.
    const lateSec = Math.round(-waitMs / 1000);
    console.log(
      `[bot] ⚠️ GitHub Actions trễ — bài sẽ lệch mốc giờ ~${lateSec}s. Đăng ngay để không bỏ lỡ slot.`,
    );
  }
}

function isFresh(article: Article): boolean {
  const ageMs = Date.now() - article.pubDate.getTime();
  return ageMs <= MAX_AGE_HOURS * 60 * 60 * 1000;
}

async function pickArticle(): Promise<Article | null> {
  console.log(`[bot] Fetching ${RSS_SOURCES.length} RSS sources...`);
  const allArticles = await fetchAllSources(RSS_SOURCES);
  console.log(`[bot] Fetched ${allArticles.length} total articles`);

  const posted = await getPostedUrls();
  console.log(`[bot] Have history of ${posted.size} previously posted URLs`);

  const candidates = allArticles.filter(
    (a) =>
      !posted.has(a.link) &&
      isFresh(a) &&
      isTechRelevantUrl(a.link) &&
      isTechRelevantTitle(a.title),
  );
  console.log(`[bot] ${candidates.length} tech-relevant candidates remain`);

  return candidates[0] ?? null;
}

async function main(): Promise<void> {
  await sleepUntilTarget();
  const article = await pickArticle();
  if (!article) {
    console.log("[bot] No fresh unposted article found. Skipping this run.");
    return;
  }

  console.log(`[bot] Selected: "${article.title}" (${article.source})`);
  console.log(`[bot]   Link: ${article.link}`);

  console.log("[bot] Generating Vietnamese summary with Gemini...");
  const summary = await summarizeArticle(article);
  console.log(`[bot]   Title: ${summary.title}`);

  console.log("[bot] Posting to Telegram channel...");
  await postArticle(article, summary);

  await markPosted(article.link, summary.title);
  console.log("[bot] Done!");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[bot] FATAL:", err);
    process.exit(1);
  });
