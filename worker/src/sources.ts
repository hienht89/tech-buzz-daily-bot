export type RssSource = {
  name: string;
  url: string;
};

export const RSS_SOURCES: RssSource[] = [
  // Báo công nghệ tier-1 quốc tế
  { name: "TechCrunch", url: "https://techcrunch.com/feed/" },
  { name: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index" },
  { name: "Engadget", url: "https://www.engadget.com/rss.xml" },
  { name: "MIT Technology Review", url: "https://www.technologyreview.com/feed/" },
  { name: "Wired", url: "https://www.wired.com/feed/rss" },
  { name: "BBC Technology", url: "https://feeds.bbci.co.uk/news/technology/rss.xml" },
  { name: "The Guardian Tech", url: "https://www.theguardian.com/technology/rss" },
  { name: "CNBC Technology", url: "https://www.cnbc.com/id/19854910/device/rss/rss.html" },
  { name: "The Register", url: "https://www.theregister.com/headlines.atom" },
  { name: "The Verge Tech", url: "https://www.theverge.com/rss/tech/index.xml" },

  // AI chuyên sâu
  { name: "Hacker News", url: "https://hnrss.org/frontpage?points=200" },
  { name: "OpenAI Blog", url: "https://openai.com/news/rss.xml" },
  { name: "Google AI Blog", url: "https://blog.google/technology/ai/rss/" },
  { name: "DeepMind Blog", url: "https://deepmind.google/blog/rss.xml" },
  { name: "Hugging Face Blog", url: "https://huggingface.co/blog/feed.xml" },
  { name: "VentureBeat AI", url: "https://venturebeat.com/category/ai/feed/" },
  { name: "The Verge AI", url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml" },
  { name: "arXiv cs.AI", url: "http://export.arxiv.org/rss/cs.AI" },

  // Apple / Google / Mobile
  { name: "9to5Mac", url: "https://9to5mac.com/feed/" },
  { name: "9to5Google", url: "https://9to5google.com/feed/" },
  { name: "MacRumors", url: "https://feeds.macrumors.com/MacRumors-All" },
  { name: "Android Authority", url: "https://www.androidauthority.com/feed/" },

  // Dev / Hardware
  { name: "GitHub Blog", url: "https://github.blog/feed/" },
  { name: "Tom's Hardware", url: "https://www.tomshardware.com/feeds/all" },
  { name: "Stack Overflow Blog", url: "https://stackoverflow.blog/feed/" },
];

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
