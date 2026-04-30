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
 * lấy `p25` — tức 1/4 phần dưới của các bài đã post — làm sàn → bot chỉ chấp
 * nhận bài cao hơn ~75% history → tự thích nghi.
 *
 * Clamp [MIN_CLAMP, MAX_CLAMP] để bảo vệ trong các trường hợp pathological:
 *   - Vài ngày RSS yếu → toàn bài score thấp → percentile tụt < 170 → bot
 *     có thể bắt đầu post rác. Clamp dưới chặn.
 *   - Vài ngày toàn bài "đại bịch" → percentile leo > 260 → bot có thể tự
 *     bịt mồm, skip slot oan dù bài còn lại vẫn khá. Clamp trên chặn.
 *
 * Cold start: khi history < MIN_HISTORY_FOR_DYNAMIC entry (vd KV vừa bị xóa,
 * hoặc bot mới deploy), trả `FALLBACK_THRESHOLD` (195) để giữ bot post được
 * trong giai đoạn đầu thay vì chọn 1 percentile có quá ít mẫu (dễ lệch).
 *
 * Module này KHÔNG đụng KV, KHÔNG đụng Cloudflare runtime → unit-test thuần
 * trong Node được.
 */

/**
 * Ngưỡng dùng khi history < MIN_HISTORY_FOR_DYNAMIC.
 *
 * Phase 19.5 (30/4/2026): hạ 220 → 195 sau khi quan sát bot bỏ slot do
 * cold-start fallback quá khắt khe (xem replit.md). 195 ≈ Phase 18.5 (190)
 * cộng buffer nhẹ vì đã có thêm filter strict (arxiv, fluff, path penalty).
 */
export const FALLBACK_THRESHOLD = 195;

/**
 * Sàn dưới: dù percentile history có tụt thấp đến mấy, threshold không < 170.
 *
 * Phase 19.5: hạ 180 → 170 để dynamic mode còn dư địa hạ thêm vào những giờ
 * tin yếu mà không bị floor cứng chặn — clamp 260 trên vẫn bảo vệ chất lượng.
 */
export const MIN_CLAMP = 170;

/** Trần trên: dù percentile history có leo cao đến mấy, threshold không > 260. */
export const MAX_CLAMP = 260;

/**
 * Percentile mặc định (25%) — chỉ loại 1/4 bài kém điểm nhất trong history.
 *
 * Phase 19.5: hạ 0.4 → 0.25 sau khi p40 cho ra ~234 (cao hơn cả fallback cũ
 * 220), khiến bot vẫn skip slot trong giờ tin yếu kể cả khi dynamic mode
 * kích hoạt. p25 cho dynamic threshold ~210-215 — đủ chặn rác, không khắt
 * khe quá vào giờ tin chậm.
 */
export const DEFAULT_PERCENTILE = 0.25;

/**
 * Số mẫu tối thiểu trước khi tin percentile. < số này → fallback.
 *
 * Phase 19.5: hạ 20 → 10 để rút ngắn cold-start. Với 12-18 tick/ngày, 10
 * mẫu ≈ 12-20 giờ — bot kích hoạt dynamic ngay trong ngày deploy thay vì
 * phải chờ qua đêm.
 */
export const MIN_HISTORY_FOR_DYNAMIC = 10;

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
 *  - history < MIN_HISTORY_FOR_DYNAMIC → trả FALLBACK_THRESHOLD (195).
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
