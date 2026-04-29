/**
 * Tự dò ngưỡng chất lượng (Task 7) — `MIN_SCORE_THRESHOLD` không còn hard-code.
 *
 * Vấn đề trước đây: `MIN_SCORE_THRESHOLD = 220` chọn dựa trên dry-run thủ công
 * 1 lần (Phase 15). Khi nguồn RSS thay đổi (vd thêm/xóa source) hoặc keyword
 * bonus được điều chỉnh, ngưỡng cũ có thể trở nên quá cao (skip slot oan) hoặc
 * quá thấp (post bài rác). Mỗi lần phải edit code + redeploy là phiền.
 *
 * Giải pháp: tự tính ngưỡng động từ phân phối score thực tế của những bài đã
 * post (lưu trong KV `score_history_v1`, cap 200 entry ~ 22 ngày). Mặc định
 * lấy `p40` — tức nửa phần dưới của các bài đã post — làm sàn → bot chỉ chấp
 * nhận bài cao hơn ~60% history → tự thích nghi.
 *
 * Clamp [MIN_CLAMP, MAX_CLAMP] để bảo vệ trong các trường hợp pathological:
 *   - Vài ngày RSS yếu → toàn bài score thấp → p40 tụt < 180 → bot có thể
 *     bắt đầu post rác. Clamp dưới chặn.
 *   - Vài ngày toàn bài "đại bịch" → p40 leo > 260 → bot có thể tự bịt mồm,
 *     skip slot oan dù bài còn lại vẫn khá. Clamp trên chặn.
 *
 * Cold start: khi history < MIN_HISTORY_FOR_DYNAMIC entry (vd KV vừa bị xóa,
 * hoặc bot mới deploy), trả `FALLBACK_THRESHOLD` (= ngưỡng cũ 220) để giữ
 * hành vi quen thuộc thay vì chọn 1 percentile có 5-10 mẫu (dễ lệch).
 *
 * Module này KHÔNG đụng KV, KHÔNG đụng Cloudflare runtime → unit-test thuần
 * trong Node được.
 */

/** Ngưỡng dùng khi history < MIN_HISTORY_FOR_DYNAMIC. Khớp với hành vi cũ. */
export const FALLBACK_THRESHOLD = 220;

/** Sàn dưới: dù p40 history có tụt thấp đến mấy, threshold không < 180. */
export const MIN_CLAMP = 180;

/** Trần trên: dù p40 history có leo cao đến mấy, threshold không > 260. */
export const MAX_CLAMP = 260;

/** Percentile mặc định (40%) — "nửa dưới" của post history. */
export const DEFAULT_PERCENTILE = 0.4;

/**
 * Số mẫu tối thiểu trước khi tin percentile. < số này → fallback. Chọn 20
 * vì với 9 tick/ngày, 20 mẫu ≈ 2 ngày — vừa đủ qua giai đoạn cold start mà
 * không phải đợi cả tuần để dynamic mode kick in.
 */
export const MIN_HISTORY_FOR_DYNAMIC = 20;

/**
 * Hàm percentile R-7 (Excel `PERCENTILE.INC`, NumPy default `linear`).
 *  - Sort ASC.
 *  - Position = p × (n - 1).
 *  - Linear interpolation giữa 2 phần tử kẹp.
 *
 * Lý do chọn R-7 (chứ không phải nearest-rank): với n nhỏ (vd 20-40 mẫu),
 * nearest-rank cho jump rời rạc — thêm/bớt 1 entry có thể nhảy cả chục điểm,
 * threshold zig-zag mỗi tick. Linear interpolation mượt hơn → bot ít bị
 * "đổi nhịp" theo từng entry mới.
 *
 * `p` được clamp về [0, 1] để caller pass nhầm 40 (thay vì 0.40) không
 * crash — chỉ trả max value.
 */
export function percentileOf(values: readonly number[], p: number): number {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length === 0) return 0;
  const sorted = [...clean].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const pp = Math.max(0, Math.min(1, p));
  const idx = pp * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

function clamp(x: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, x));
}

/**
 * Tính threshold động từ history score.
 *
 *  - history < MIN_HISTORY_FOR_DYNAMIC → trả FALLBACK_THRESHOLD (220).
 *  - Else: round(percentile p) clamp về [MIN_CLAMP, MAX_CLAMP].
 *
 * Round trước khi clamp để output luôn nguyên (tiện log + so sánh `score <
 * threshold`). Clamp sau round để đảm bảo output ⊆ [MIN_CLAMP, MAX_CLAMP]
 * dù raw percentile rơi sát rìa (vd 179.6 → round 180, không bị clamp đẩy).
 *
 * `percentile` không được mặc định bằng tham số "??" mà dùng default param
 * vì caller có thể truyền explicit 0 (vd test edge case) — `?? DEFAULT` sẽ
 * sai. Chỉ dùng default khi caller không truyền.
 */
export function computeDynamicThreshold(
  history: readonly { score: number }[],
  percentile: number = DEFAULT_PERCENTILE,
): number {
  if (history.length < MIN_HISTORY_FOR_DYNAMIC) {
    return FALLBACK_THRESHOLD;
  }
  const raw = percentileOf(
    history.map((h) => h.score),
    percentile,
  );
  return clamp(Math.round(raw), MIN_CLAMP, MAX_CLAMP);
}
