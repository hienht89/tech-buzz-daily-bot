import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../../data");
const POSTED_FILE = path.join(DATA_DIR, "posted.json");

const MAX_HISTORY = 1000;

type PostedEntry = {
  url: string;
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

export async function isPosted(url: string): Promise<boolean> {
  const data = await loadPosted();
  return data.entries.some((e) => e.url === url);
}

export async function markPosted(url: string, title: string): Promise<void> {
  const data = await loadPosted();
  data.entries.push({ url, title, postedAt: new Date().toISOString() });
  if (data.entries.length > MAX_HISTORY) {
    data.entries = data.entries.slice(-MAX_HISTORY);
  }
  await fs.writeFile(POSTED_FILE, JSON.stringify(data, null, 2), "utf8");
}

export async function getPostedUrls(): Promise<Set<string>> {
  const data = await loadPosted();
  return new Set(data.entries.map((e) => e.url));
}
