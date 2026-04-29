/**
 * Counter cho slot bị bot bỏ trống do "all candidates below MIN_SCORE_THRESHOLD".
 *
 * Tách module riêng (KHÔNG để trong storage.ts) vì 2 lý do:
 *   1. Không có runtime dependency nào (chỉ cần KV) → unit-test được trong
 *      Node bằng `node --experimental-strip-types --test` không phải mock chain
 *      url/dedup như storage.ts.
 *   2. Counter có ý nghĩa độc lập với book-keeping post (URL/title hash, fail
 *      count, recent_titles): thuộc nhóm "monitoring/alert", không phải "post
 *      lifecycle" → tách file giúp đọc rõ ý đồ.
 *
 * KV layout:
 *   key   = `skipped:YYYY-MM-DD`  (UTC, khớp dayKey trong bucket.ts)
 *   value = stringified integer
 *   TTL   = 36h  → counter ngày trước vẫn còn sống đến sáng ngày sau (giúp
 *                  admin truy cứu) nhưng vẫn auto-cleanup, không tích lũy.
 */

const SKIPPED_SLOT_PREFIX = "skipped:";
const SKIPPED_SLOT_TTL_SECONDS = 36 * 60 * 60;

/**
 * Subset KVNamespace: chỉ cần put/get để counter chạy. Match với `KvLike`
 * trong `diag.ts` để có thể chia sẻ fake KV trong test (nhưng cố ý KHÔNG
 * import từ diag.ts để giữ module này tự contained).
 */
export type SkipCounterKv = {
  put: (key: string, value: string, opts?: { expirationTtl?: number }) => Promise<void>;
  get: (key: string) => Promise<string | null>;
};

function skippedSlotKey(dayKey: string): string {
  return `${SKIPPED_SLOT_PREFIX}${dayKey}`;
}

/**
 * Đọc số slot đã bị skip do "all candidates below MIN_SCORE_THRESHOLD" trong
 * ngày `dayKey` (UTC). Trả 0 nếu chưa có entry, value corrupt (NaN), hoặc TTL
 * đã hết.
 */
export async function getSkippedSlotCount(
  kv: SkipCounterKv,
  dayKey: string,
): Promise<number> {
  const v = await kv.get(skippedSlotKey(dayKey));
  if (!v) return 0;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Tăng counter slot bị skip cho ngày `dayKey`, return số mới. Auto-reset mỗi
 * ngày qua TTL (xem SKIPPED_SLOT_TTL_SECONDS).
 *
 * Caller (runBotInternal) gọi đúng MỘT lần cho mỗi tick mà bot bỏ trống slot
 * vì lý do `all candidates below MIN_SCORE_THRESHOLD`. Reason "all candidates
 * failed" hay "all RSS sources failed" KHÔNG tính vào counter này (sẽ có
 * cảnh báo riêng cho AI quota / network — task khác trong backlog).
 *
 * KHÔNG atomic giữa get + put: 2 cron tick chạy đồng thời ở 2 isolate khác
 * nhau có thể đọc cùng `current` rồi cùng ghi `current+1`, mất 1 đếm. Chấp
 * nhận được vì:
 *   - Cron Cloudflare fire 1 lần / 2h → race window cực hẹp.
 *   - Bot có single-flight mutex trong cùng isolate (xem `inflightRun`).
 *   - Mất 1 đếm chỉ làm alert đến CHẬM 1 tick — không silent fail nghiêm trọng.
 */
export async function incrementSkippedSlotCount(
  kv: SkipCounterKv,
  dayKey: string,
): Promise<number> {
  const current = await getSkippedSlotCount(kv, dayKey);
  const next = current + 1;
  await kv.put(skippedSlotKey(dayKey), String(next), {
    expirationTtl: SKIPPED_SLOT_TTL_SECONDS,
  });
  return next;
}

// ────────────────────────────────────────────────────────────────────────────
// Flag "đã gửi cảnh báo skipped-slot trong ngày X chưa"
//
// Mục đích: nếu Telegram transient down ĐÚNG tick counter cross threshold (vd
// count=3), KHÔNG được mất alert vĩnh viễn. Cách giải:
//   - Mỗi tick gọi maybeAlert thấy count >= threshold → check flag.
//   - Flag chưa có → thử gửi. Gửi thành công → set flag (TTL 36h).
//   - Flag đã có → silent (đã alert hôm nay, không spam).
// Hậu quả: alert được retry mỗi tick (cách 2h) cho tới khi gửi thành công 1
// lần, sau đó im hết ngày. Worst-case admin chỉ trễ 2h thay vì miss luôn.
// ────────────────────────────────────────────────────────────────────────────

const ALERT_SENT_PREFIX = "skipped_alert_sent:";
const ALERT_SENT_TTL_SECONDS = 36 * 60 * 60;

function alertSentKey(dayKey: string): string {
  return `${ALERT_SENT_PREFIX}${dayKey}`;
}

/** True nếu admin đã được alert skipped-slot cho `dayKey` (UTC). */
export async function wasAdminAlertSent(
  kv: SkipCounterKv,
  dayKey: string,
): Promise<boolean> {
  const v = await kv.get(alertSentKey(dayKey));
  return v === "1";
}

/** Đánh dấu đã gửi alert skipped-slot cho `dayKey` để tick sau không spam. */
export async function markAdminAlertSent(
  kv: SkipCounterKv,
  dayKey: string,
): Promise<void> {
  await kv.put(alertSentKey(dayKey), "1", {
    expirationTtl: ALERT_SENT_TTL_SECONDS,
  });
}
