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
