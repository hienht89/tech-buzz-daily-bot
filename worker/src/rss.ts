import { XMLParser } from "fast-xml-parser";
import type { RssSource } from "./sources.js";

export type Article = {
  title: string;
  link: string;
  pubDate: Date;
  source: string;
  contentSnippet: string;
  imageUrl?: string;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  isArray: (name) => ["item", "entry", "link", "media:content", "media:thumbnail"].includes(name),
});

type AnyObj = Record<string, unknown>;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&#([0-9]+);/g, (_, dec) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name] ?? m);
}

function strOrEmpty(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return decodeEntities(v).trim();
  if (typeof v === "object") {
    const t = (v as AnyObj)["#text"];
    if (typeof t === "string") return decodeEntities(t).trim();
  }
  return decodeEntities(String(v)).trim();
}

function getAttr(obj: unknown, key: string): string | undefined {
  if (obj && typeof obj === "object") {
    const v = (obj as AnyObj)[`@_${key}`];
    if (typeof v === "string") return v;
  }
  return undefined;
}

function getLink(item: AnyObj): string {
  const l = item.link;
  if (typeof l === "string") return l.trim();
  if (Array.isArray(l)) {
    // Atom: prefer rel="alternate" or one without rel
    for (const x of l) {
      const rel = getAttr(x, "rel");
      if (!rel || rel === "alternate") {
        const href = getAttr(x, "href");
        if (href) return href.trim();
        const txt = strOrEmpty(x);
        if (txt) return txt;
      }
    }
    // Fallback: first link
    const first = l[0];
    const href = getAttr(first, "href");
    if (href) return href.trim();
    return strOrEmpty(first);
  }
  if (l && typeof l === "object") {
    const href = getAttr(l, "href");
    if (href) return href.trim();
    return strOrEmpty(l);
  }
  return "";
}

/**
 * Lấy pubDate từ item RSS/Atom. Nếu KHÔNG parse được, trả về EPOCH (1970)
 * thay vì `new Date()` — vì fallback "now" sẽ PROMOTE bài cũ thiếu ngày lên
 * đầu sort newest-first → bot pick liên tục bài đó → dễ poison loop.
 * Dùng epoch khiến bài đó rớt xuống cuối sort + sẽ bị `isFresh()` (>48h) loại.
 */
const EPOCH = new Date(0);

export function getPubDate(item: AnyObj): Date {
  const candidates = [item.pubDate, item.published, item.updated, item["dc:date"]];
  for (const c of candidates) {
    const s = strOrEmpty(c);
    if (s) {
      const d = new Date(s);
      if (!isNaN(d.getTime())) return d;
    }
  }
  return EPOCH;
}

function getImageUrl(item: AnyObj): string | undefined {
  // media:content (array because of isArray rule)
  const mc = item["media:content"];
  if (Array.isArray(mc)) {
    for (const m of mc) {
      const url = getAttr(m, "url");
      if (url) return url;
    }
  }
  // media:thumbnail
  const mt = item["media:thumbnail"];
  if (Array.isArray(mt)) {
    for (const m of mt) {
      const url = getAttr(m, "url");
      if (url) return url;
    }
  }
  // enclosure
  const enc = item.enclosure;
  if (enc) {
    const url = getAttr(enc, "url");
    if (url) return url;
  }
  // Extract from content HTML
  const html =
    strOrEmpty(item["content:encoded"]) ||
    strOrEmpty(item.description) ||
    strOrEmpty(item.content) ||
    strOrEmpty(item.summary);
  if (html) {
    const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * Trích xuất text từ giá trị có thể là string, object phức tạp, hay array — đệ quy.
 * Cần thiết khi feed dùng `description` / `content` dạng object thay vì string thuần,
 * tránh bị coerce thành "[object Object]" làm hỏng input cho Gemini.
 */
function deepText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(deepText).join(" ");
  if (typeof v === "object") {
    const parts: string[] = [];
    for (const [k, val] of Object.entries(v as AnyObj)) {
      // Bỏ qua attribute (key bắt đầu bằng "@_")
      if (k.startsWith("@_")) continue;
      parts.push(deepText(val));
    }
    return parts.join(" ");
  }
  return "";
}

function getContentSnippet(item: AnyObj): string {
  // Ưu tiên field nào có content có ý nghĩa (không phải rỗng / object trống)
  const sources = [
    item.description,
    item["content:encoded"],
    item.content,
    item.summary,
  ];
  let raw = "";
  for (const s of sources) {
    const txt = deepText(s).trim();
    if (txt) {
      raw = txt;
      break;
    }
  }
  if (!raw) return "";
  // Decode entity, strip HTML, normalize whitespace
  return decodeEntities(raw)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Timeout per source — tránh 1 nguồn slow block toàn bộ Promise.all
const FETCH_TIMEOUT_MS = 12_000;

// Giới hạn số bài lấy từ MỖI nguồn (lấy bài mới nhất sau khi parse).
// Giảm CPU dành cho parse + sort + filter trên free plan của Cloudflare.
const MAX_ITEMS_PER_SOURCE = 25;

export async function fetchSource(source: RssSource): Promise<Article[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(source.url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; TechBuzzBot/1.0; +https://t.me/techbuzz_daily)",
        Accept:
          "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
      },
      cf: { cacheTtl: 0, cacheEverything: false } as RequestInit["cf"],
    });
    if (!res.ok) {
      console.warn(`[rss] ${source.name}: HTTP ${res.status}`);
      return [];
    }
    const xml = await res.text();
    const data = parser.parse(xml) as AnyObj;

    // RSS 2.0: rss.channel.item[]
    // Atom: feed.entry[]
    const rss = (data.rss as AnyObj | undefined) ?? (data.RSS as AnyObj | undefined);
    const channel = rss ? (rss.channel as AnyObj | undefined) : undefined;
    const feed = data.feed as AnyObj | undefined;

    let items: AnyObj[] = [];
    if (channel?.item) items = channel.item as AnyObj[];
    else if (feed?.entry) items = feed.entry as AnyObj[];
    else if ((data.channel as AnyObj | undefined)?.item)
      items = (data.channel as AnyObj).item as AnyObj[];

    if (items.length === 0) {
      console.warn(`[rss] ${source.name}: 0 items parsed (feed format unrecognized?)`);
      return [];
    }

    // Lấy tối đa MAX_ITEMS_PER_SOURCE bài đầu tiên (RSS thường sort newest-first)
    const limited = items.slice(0, MAX_ITEMS_PER_SOURCE);

    const articles: Article[] = [];
    for (const item of limited) {
      const link = getLink(item);
      const title = strOrEmpty(item.title);
      if (!link || !title) continue;
      articles.push({
        title,
        link,
        pubDate: getPubDate(item),
        source: source.name,
        contentSnippet: getContentSnippet(item),
        imageUrl: getImageUrl(item),
      });
    }
    return articles;
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    const reason = (err as Error).name === "AbortError"
      ? `timeout after ${FETCH_TIMEOUT_MS}ms`
      : msg;
    console.error(`[rss] Failed to fetch ${source.name}: ${reason}`);
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

// Sau khi sort, chỉ giữ top N để giảm CPU cho filter + KV lookup.
const TOP_ARTICLES_AFTER_SORT = 200;

export type SourceStat = {
  name: string;
  url: string;
  count: number;
  ok: boolean;
};

export type FetchAllResult = {
  articles: Article[];
  stats: SourceStat[];
};

export async function fetchAllSources(
  sources: RssSource[],
): Promise<FetchAllResult> {
  const results = await Promise.all(sources.map(fetchSource));

  const stats: SourceStat[] = sources.map((s, i) => ({
    name: s.name,
    url: s.url,
    count: results[i].length,
    ok: results[i].length > 0,
  }));

  // Log per-source counts để dễ debug khi không có bài
  const summary = stats.map((s) => `${s.name}=${s.count}`).join(" ");
  console.log(`[rss] Fetched per-source: ${summary}`);

  const failedCount = stats.filter((s) => !s.ok).length;
  if (failedCount > 0) {
    console.warn(`[rss] ${failedCount}/${sources.length} sources returned 0 articles`);
  }

  const articles = results.flat();
  articles.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());
  return {
    articles: articles.slice(0, TOP_ARTICLES_AFTER_SORT),
    stats,
  };
}
