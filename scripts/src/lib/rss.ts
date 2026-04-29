import Parser from "rss-parser";
import type { RssSource } from "./sources.js";

export type Article = {
  title: string;
  link: string;
  pubDate: Date;
  source: string;
  contentSnippet: string;
  imageUrl?: string;
};

type CustomItem = {
  "media:content"?: { $?: { url?: string } } | Array<{ $?: { url?: string } }>;
  "media:thumbnail"?: { $?: { url?: string } } | Array<{ $?: { url?: string } }>;
  "content:encoded"?: string;
  enclosure?: { url?: string };
};

const parser: Parser<unknown, CustomItem> = new Parser({
  timeout: 15_000,
  customFields: {
    item: ["media:content", "media:thumbnail", "enclosure"],
  },
  headers: {
    "User-Agent":
      "Mozilla/5.0 (compatible; TechBuzzBot/1.0; +https://t.me/techbuzz_daily)",
  },
});

function pickMediaUrl(item: CustomItem): string | undefined {
  const mc = item["media:content"];
  if (Array.isArray(mc) && mc[0]?.$?.url) return mc[0].$.url;
  if (mc && !Array.isArray(mc) && mc.$?.url) return mc.$.url;

  const mt = item["media:thumbnail"];
  if (Array.isArray(mt) && mt[0]?.$?.url) return mt[0].$.url;
  if (mt && !Array.isArray(mt) && mt.$?.url) return mt.$.url;

  if (item.enclosure?.url) return item.enclosure.url;
  return undefined;
}

function extractImageFromHtml(html: string | undefined): string | undefined {
  if (!html) return undefined;
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return m?.[1];
}

const EPOCH = new Date(0);

/**
 * Parse pubDate từ RSS. Trả EPOCH (1970) nếu không có hoặc không parse được —
 * tránh promote bài thiếu ngày lên top sort newest-first.
 */
function parsePubDate(
  isoDate: string | undefined,
  pubDate: string | undefined,
): Date {
  for (const candidate of [isoDate, pubDate]) {
    if (!candidate) continue;
    const d = new Date(candidate);
    if (!isNaN(d.getTime())) return d;
  }
  return EPOCH;
}

export async function fetchSource(source: RssSource): Promise<Article[]> {
  try {
    const feed = await parser.parseURL(source.url);
    const items = feed.items ?? [];
    const articles: Article[] = [];
    for (const item of items) {
      const link = item.link?.trim();
      const title = item.title?.trim();
      if (!link || !title) continue;
      // Nếu pubDate KHÔNG parse được, dùng EPOCH (1970) thay vì `new Date()`.
      // Lý do: fallback "now" sẽ promote bài cũ thiếu ngày lên top sort
      // newest-first → bot pick cùng 1 bài mãi → poison loop.
      const pubDate = parsePubDate(item.isoDate, item.pubDate);
      const imageUrl =
        pickMediaUrl(item as CustomItem) ??
        extractImageFromHtml(item.content) ??
        extractImageFromHtml(item["content:encoded"] as string | undefined);
      articles.push({
        title,
        link,
        pubDate,
        source: source.name,
        contentSnippet: (item.contentSnippet ?? item.content ?? "").trim(),
        imageUrl,
      });
    }
    return articles;
  } catch (err) {
    console.error(`[rss] Failed to fetch ${source.name}: ${(err as Error).message}`);
    return [];
  }
}

export async function fetchAllSources(sources: RssSource[]): Promise<Article[]> {
  const results = await Promise.all(sources.map(fetchSource));
  const articles = results.flat();
  articles.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());
  return articles;
}
