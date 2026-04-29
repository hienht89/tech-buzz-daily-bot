/**
 * RSS source registry với category + priority.
 *
 * CATEGORY → bucket selection:
 *   core     — báo tech tổng hợp chất lượng cao (lớp phủ tin chung)
 *   ai       — labs / blog AI (source gốc về nghiên cứu + sản phẩm)
 *   dev      — engineering / developer content (chuyên sâu kỹ thuật)
 *   research — paper / academic / nghiên cứu chuyên sâu
 *   trend    — signal cộng đồng (HN…) — chỉ làm trend boost, KHÔNG được lấn slot
 *
 * PRIORITY → scoring weight:
 *   1 — primary source (lab gốc, engineering blog tự sự, paper repo)
 *   2 — quality outlet (báo tier-1 quốc tế, có editorial)
 *   3 — aggregator / signal (HN, link rollup)
 *
 * Quy ước: nếu cùng 1 sự kiện được nhiều nguồn đăng, bài từ priority THẤP HƠN
 * (1 < 2 < 3) sẽ thắng (xem `dedup.ts` event-clustering). Nhờ đó OpenAI Blog
 * thắng TechCrunch khi cùng nói về cùng 1 release.
 */
export type SourceCategory = "core" | "ai" | "dev" | "research" | "trend";
export type SourcePriority = 1 | 2 | 3;

export type RssSource = {
  name: string;
  url: string;
  category: SourceCategory;
  priority: SourcePriority;
};

export const RSS_SOURCES: RssSource[] = [
  // ───── CORE: báo tech tổng hợp tier-1 ─────
  { name: "TechCrunch",       url: "https://techcrunch.com/feed/",                     category: "core", priority: 2 },
  { name: "The Verge Tech",   url: "https://www.theverge.com/rss/tech/index.xml",      category: "core", priority: 2 },
  { name: "Wired",            url: "https://www.wired.com/feed/rss",                   category: "core", priority: 2 },
  { name: "Ars Technica",     url: "https://feeds.arstechnica.com/arstechnica/index",  category: "core", priority: 2 },
  { name: "BBC Technology",   url: "https://feeds.bbci.co.uk/news/technology/rss.xml", category: "core", priority: 2 },

  // ───── AI: labs gốc + paper ─────
  { name: "OpenAI Blog",      url: "https://openai.com/news/rss.xml",                  category: "ai", priority: 1 },
  { name: "Google AI Blog",   url: "https://blog.google/technology/ai/rss/",           category: "ai", priority: 1 },
  { name: "DeepMind Blog",    url: "https://deepmind.google/blog/rss.xml",             category: "ai", priority: 1 },
  { name: "Anthropic News",   url: "https://www.anthropic.com/news/rss.xml",           category: "ai", priority: 1 },
  { name: "Meta AI Blog",     url: "https://ai.facebook.com/blog/rss/",                category: "ai", priority: 1 },
  { name: "Hugging Face Blog",url: "https://huggingface.co/blog/feed.xml",             category: "ai", priority: 1 },
  { name: "arXiv cs.AI",      url: "http://export.arxiv.org/rss/cs.AI",                category: "ai", priority: 2 },

  // ───── DEV: engineering / developer content ─────
  { name: "GitHub Blog",         url: "https://github.blog/feed/",          category: "dev", priority: 1 },
  { name: "Netflix Tech Blog",   url: "https://netflixtechblog.com/feed",   category: "dev", priority: 1 },
  { name: "Stack Overflow Blog", url: "https://stackoverflow.blog/feed/",   category: "dev", priority: 1 },
  { name: "InfoQ",               url: "https://feed.infoq.com/",            category: "dev", priority: 2 },

  // ───── RESEARCH / TREND ─────
  { name: "Papers with Code", url: "https://paperswithcode.com/rss",                 category: "research", priority: 2 },
  // HN làm trend signal — priority 3 + sẽ có penalty trong scoring để KHÔNG lấn
  // bài chính thức. Chỉ post khi có bài HN cực hot mà không nguồn nào khác đưa.
  { name: "Hacker News",      url: "https://hnrss.org/frontpage?points=120",         category: "trend",    priority: 3 },
];

// ────────────────────────────────────────────────────────────────────────────
// URL + title heuristic filter (giữ nguyên từ phiên bản trước)
// ────────────────────────────────────────────────────────────────────────────

const NON_TECH_PATH_PATTERNS = [
  "/entertainment/",
  "/politics/",
  "/sports/",
  "/movies/",
  "/tv/",
  "/music/",
  "/celebrity/",
  "/lifestyle/",
  "/health/",
  "/food/",
  "/news/919",
  "/news/920",
  "/news/921",
];

export function isTechRelevantUrl(url: string): boolean {
  const lower = url.toLowerCase();
  for (const pattern of NON_TECH_PATH_PATTERNS) {
    if (lower.includes(pattern)) return false;
  }
  return true;
}

const NON_TECH_TITLE_KEYWORDS = [
  "shooting",
  "election",
  "trump",
  "biden",
  "celebrity",
  "kardashian",
  "taylor swift",
  "nfl",
  "nba",
  "world cup",
  "war in",
  "ukraine war",
];

export function isTechRelevantTitle(title: string): boolean {
  const lower = title.toLowerCase();
  for (const kw of NON_TECH_TITLE_KEYWORDS) {
    if (lower.includes(kw)) return false;
  }
  return true;
}
