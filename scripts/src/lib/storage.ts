import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeUrl } from "./url.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../../data");
const POSTED_FILE = path.join(DATA_DIR, "posted.json");

const MAX_HISTORY = 1000;

type PostedEntry = {
  url: string; // RAW URL gốc (lưu để hiển thị/audit)
  canonicalUrl?: string; // URL đã normalize — KEY thật để dedupe
  title: string;
  postedAt: string;
};

type PostedFile = {
  entries: PostedEntry[];
};

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function loadPosted(): Promise<PostedFile> {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(POSTED_FILE, "utf8");
    const parsed = JSON.parse(raw) as PostedFile;
    if (!parsed.entries) return { entries: [] };
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { entries: [] };
    }
    throw err;
  }
}

/**
 * Lấy canonical key cho 1 entry — ưu tiên field `canonicalUrl` (entry mới),
 * fallback re-normalize từ `url` (entry cũ trước khi migrate).
 */
function entryKey(entry: PostedEntry): string {
  return entry.canonicalUrl ?? normalizeUrl(entry.url);
}

export async function isPosted(url: string): Promise<boolean> {
  const data = await loadPosted();
  const key = normalizeUrl(url);
  return data.entries.some((e) => entryKey(e) === key);
}

export async function markPosted(url: string, title: string): Promise<void> {
  const data = await loadPosted();
  data.entries.push({
    url,
    canonicalUrl: normalizeUrl(url),
    title,
    postedAt: new Date().toISOString(),
  });
  if (data.entries.length > MAX_HISTORY) {
    data.entries = data.entries.slice(-MAX_HISTORY);
  }
  await fs.writeFile(POSTED_FILE, JSON.stringify(data, null, 2), "utf8");
}

/**
 * Trả về set các URL ĐÃ NORMALIZE để caller có thể check `set.has(normalizeUrl(x))`.
 */
export async function getPostedUrls(): Promise<Set<string>> {
  const data = await loadPosted();
  return new Set(data.entries.map((e) => entryKey(e)));
}
