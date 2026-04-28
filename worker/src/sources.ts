export type RssSource = {
  name: string;
  url: string;
};

export const RSS_SOURCES: RssSource[] = [
  { name: "TechCrunch", url: "https://techcrunch.com/feed/" },
  { name: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index" },
  { name: "Engadget", url: "https://www.engadget.com/rss.xml" },
  { name: "MIT Technology Review", url: "https://www.technologyreview.com/feed/" },
  { name: "Hacker News", url: "https://hnrss.org/frontpage?points=200" },
  { name: "OpenAI Blog", url: "https://openai.com/news/rss.xml" },
  { name: "Google AI Blog", url: "https://blog.google/technology/ai/rss/" },
  { name: "VentureBeat AI", url: "https://venturebeat.com/category/ai/feed/" },
  { name: "The Verge Tech", url: "https://www.theverge.com/rss/tech/index.xml" },
  { name: "The Verge AI", url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml" },
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
