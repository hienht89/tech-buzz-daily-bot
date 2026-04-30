import type { Article } from "./rss.js";
import type { Summary } from "./ai.js";
import type { SourceCategory, SourcePriority } from "./sources.js";

/**
 * ────────────────────────────────────────────────────────────────────────────
 * Queue module (Phase 19.8) — pre-generated post scheduling.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Mục đích: tách hoàn toàn 2 pha "tóm tắt bằng AI" và "gửi lên Telegram"
 * để cron post hourly KHÔNG còn phụ thuộc Gemini uptime tại thời điểm tick.
 *
 *   Pha 1 — REFILL (chạy 1 lần/ngày, lúc Mỹ ngủ → Gemini ổn):
 *     Fetch RSS → filter → score → dedup → AI summarize 18 bài →
 *     enqueueSlot vào KV với key `queue:YYYY-MM-DDTHH` (UTC hour).
 *
 *   Pha 2 — POST (cron `0 0-17 * * *`, mỗi tick):
 *     dequeueSlot(currentSlotKey) → postArticle → mark posted.
 *     Nếu queue empty → fallback realtime AI (safety net, không miss slot).
 *
 * Lý do dùng KV + hour-resolution slot key (vs list-based queue):
 *   - Idempotent: refill chạy lại không dup (cùng slotKey ghi đè).
 *   - O(1) read tại post time (không cần list/sort).
 *   - Auto-expire 36h: nếu refill miss + post miss → KV tự dọn, không leak.
 *
 * KV TTL 36h được chọn để:
 *   - Đủ thời gian cho refill ngày mai overlap an toàn (refill A ~12h trước,
 *     post latest ~12h sau, +12h buffer = 36h).
 *   - Không quá dài để leak slot ngày hôm qua nếu logic dequeue có bug.
 */

/** TTL queue entry — 36h auto-cleanup. Đủ để overlap 2 chu kỳ refill. */
const SLOT_TTL_SECONDS = 36 * 3600;

/**
 * Article dạng JSON-serializable (pubDate Date → ISO string).
 * Dùng để lưu vào KV; deserialize lại bằng `articleFromJson`.
 */
export type ArticleJson = {
  title: string;
  link: string;
  canonicalUrl: string;
  pubDate: string;
  source: string;
  sourceCategory: SourceCategory;
  sourcePriority: SourcePriority;
  contentSnippet: string;
  imageUrl?: string;
  score?: number;
  titleHash?: string;
};

export type QueuePayload = {
  article: ArticleJson;
  summary: Summary;
  generatedAt: string;
  scheduledFor: string;
  aiProvider: string;
};

/** Min ENV interface — chỉ POSTED_KV cần cho queue ops. */
export interface QueueEnv {
  POSTED_KV: KVNamespace;
}

/**
 * Build slot key (UTC, hour-resolution).
 * Format: `queue:YYYY-MM-DDTHH` (vd `queue:2026-04-30T14`).
 *
 * Ý nghĩa: bài lưu ở slot này sẽ được post vào HH:00 UTC ngày YYYY-MM-DD.
 * Cron post `0 0-17 * * *` fire mỗi giờ tròn → tự khớp slot key.
 */
export function slotKeyForUTC(d: Date): string {
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  return `queue:${y}-${mo}-${da}T${h}`;
}

/**
 * Trả về hour-aligned Date của TICK HIỆN TẠI (UTC).
 * Vd input 14:37:22 → output 14:00:00. Dùng tại post handler để tra slot.
 */
export function currentHourSlot(now: Date): Date {
  const d = new Date(now);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

/** Trả Date của tick GIỜ KẾ TIẾP (HH+1, đã align về :00). */
export function nextHourSlot(now: Date): Date {
  const d = currentHourSlot(now);
  d.setUTCHours(d.getUTCHours() + 1);
  return d;
}

/**
 * Cron post chạy `0 0-17 * * *` UTC = 18 tick/ngày từ 0h-17h UTC
 * (= 7h sáng-0h khuya VN). Slot ngoài range này KHÔNG bao giờ post.
 */
export function isPostHourUTC(hourUTC: number): boolean {
  return hourUTC >= 0 && hourUTC <= 17;
}

/**
 * Liệt kê N slot UTC kế tiếp mà cron post sẽ fire (skip 18-23 UTC).
 * Dùng tại refill: enqueue cho 18 slot kế tiếp.
 *
 * Vd: now = 06:30 UTC → next slots = 07, 08, 09, ..., 17 (11 slot today)
 * + 00, 01, 02, ..., 06 (7 slot ngày mai) = 18 total.
 */
export function enumerateNextPostSlots(now: Date, count: number): Date[] {
  const slots: Date[] = [];
  const d = nextHourSlot(now);
  while (slots.length < count) {
    if (isPostHourUTC(d.getUTCHours())) {
      slots.push(new Date(d));
    }
    d.setUTCHours(d.getUTCHours() + 1);
  }
  return slots;
}

/** Convert Article → ArticleJson (Date → ISO string). */
export function articleToJson(a: Article): ArticleJson {
  return {
    title: a.title,
    link: a.link,
    canonicalUrl: a.canonicalUrl,
    pubDate: a.pubDate.toISOString(),
    source: a.source,
    sourceCategory: a.sourceCategory,
    sourcePriority: a.sourcePriority,
    contentSnippet: a.contentSnippet,
    imageUrl: a.imageUrl,
    score: a.score,
    titleHash: a.titleHash,
  };
}

/** Convert ArticleJson → Article (ISO string → Date). */
export function articleFromJson(j: ArticleJson): Article {
  return {
    title: j.title,
    link: j.link,
    canonicalUrl: j.canonicalUrl,
    pubDate: new Date(j.pubDate),
    source: j.source,
    sourceCategory: j.sourceCategory,
    sourcePriority: j.sourcePriority,
    contentSnippet: j.contentSnippet,
    imageUrl: j.imageUrl,
    score: j.score,
    titleHash: j.titleHash,
  };
}

/**
 * Ghi 1 slot vào queue. KHÔNG check tồn tại trước — caller chịu trách nhiệm
 * (xem `peekSlot` nếu muốn skip slot đã có).
 *
 * TTL = 36h: nếu vì lý do nào đó slot không bao giờ được dequeue (vd post tick
 * không fire), KV tự xóa → không leak storage.
 */
export async function enqueueSlot(
  env: QueueEnv,
  slotDate: Date,
  payload: QueuePayload,
): Promise<void> {
  const key = slotKeyForUTC(slotDate);
  await env.POSTED_KV.put(key, JSON.stringify(payload), {
    expirationTtl: SLOT_TTL_SECONDS,
  });
}

/**
 * Đọc payload tại slot mà KHÔNG xóa. Dùng để:
 *   - /queue endpoint inspect lịch
 *   - Refill skip slot đã có content (idempotent)
 */
export async function peekSlot(
  env: QueueEnv,
  slotDate: Date,
): Promise<QueuePayload | null> {
  const raw = await env.POSTED_KV.get(slotKeyForUTC(slotDate));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as QueuePayload;
  } catch {
    return null;
  }
}

/**
 * Đọc + xóa slot. Dùng tại post handler.
 *
 * Quy tắc xóa:
 *   - Parse OK → delete + return payload (caller post lên Telegram).
 *   - Parse fail (corrupted JSON) → delete + return null (clean up rác).
 *   - Key không tồn tại → return null, không delete.
 *
 * Lưu ý race: 2 isolate đồng thời dequeue cùng slot → cả 2 có thể đọc ra
 * payload (KV không atomic). Mitigated bởi `reservePost` ở caller (URL hash KV).
 */
export async function dequeueSlot(
  env: QueueEnv,
  slotDate: Date,
): Promise<QueuePayload | null> {
  const key = slotKeyForUTC(slotDate);
  const raw = await env.POSTED_KV.get(key);
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw) as QueuePayload;
    await env.POSTED_KV.delete(key);
    return payload;
  } catch {
    await env.POSTED_KV.delete(key);
    return null;
  }
}

/** Xóa slot không đọc (cleanup helper, dùng cho /refill manual). */
export async function clearSlot(env: QueueEnv, slotDate: Date): Promise<void> {
  await env.POSTED_KV.delete(slotKeyForUTC(slotDate));
}

/**
 * Liệt kê tất cả queue entry hiện có (dùng cho /queue endpoint).
 * KV list có giới hạn 1000 keys/call — bot này tối đa ~36 entries (2 ngày
 * overlap × 18 slot) nên không cần pagination.
 */
export async function listQueue(
  env: QueueEnv,
): Promise<{ slot: string; payload: QueuePayload }[]> {
  const list = await env.POSTED_KV.list({ prefix: "queue:" });
  const out: { slot: string; payload: QueuePayload }[] = [];
  for (const k of list.keys) {
    const raw = await env.POSTED_KV.get(k.name);
    if (!raw) continue;
    try {
      out.push({ slot: k.name, payload: JSON.parse(raw) as QueuePayload });
    } catch {
      // skip corrupted
    }
  }
  out.sort((a, b) => a.slot.localeCompare(b.slot));
  return out;
}

export const __test = {
  SLOT_TTL_SECONDS,
};
