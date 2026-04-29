/**
 * Chuẩn hóa URL trước khi dùng làm key dedupe.
 * Mục tiêu: 2 link trỏ về CÙNG bài viết (chỉ khác tracking params hoặc fragment)
 * phải sinh ra cùng key trong KV.
 *
 * Quy tắc:
 *  - Lowercase host (giữ nguyên case của path vì 1 số CMS phân biệt)
 *  - Loại bỏ default port (:80 / :443)
 *  - Strip fragment (#...)
 *  - Strip các tracking query param thông dụng (utm_*, fbclid, gclid, ref, src, source, mc_cid, ...)
 *  - Bỏ trailing "/" của path (trừ khi path = "/")
 *  - Sort các query param còn lại theo alphabet để ổn định
 *  - Nếu URL không parse được → trả nguyên gốc (đã trim) — tránh crash
 */

const TRACKING_PARAM_PREFIXES = ["utm_"];

const TRACKING_PARAM_EXACT = new Set([
  "fbclid",
  "gclid",
  "msclkid",
  "yclid",
  "dclid",
  "_ga",
  "ref",
  "ref_src",
  "ref_url",
  "referrer",
  "referer",
  "src",
  "source",
  "feature",
  "feed_id",
  "feed",
  "rss",
  "share",
  "shared",
  "fromrss",
  "from_rss",
  "from",
  "mc_cid",
  "mc_eid",
  "mkt_tok",
  "hsCtaTracking",
  "_hsenc",
  "_hsmi",
  "campaign_id",
  "campaign",
  "medium",
  "guccounter",
  "guce_referrer",
  "guce_referrer_sig",
]);

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  if (TRACKING_PARAM_EXACT.has(lower)) return true;
  for (const prefix of TRACKING_PARAM_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }
  return false;
}

export function normalizeUrl(input: string): string {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return "";
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return trimmed;
  }

  // Bỏ user/pass
  u.username = "";
  u.password = "";

  // Lowercase host
  u.hostname = u.hostname.toLowerCase();

  // Bỏ default port
  if (
    (u.protocol === "http:" && u.port === "80") ||
    (u.protocol === "https:" && u.port === "443")
  ) {
    u.port = "";
  }

  // Strip fragment
  u.hash = "";

  // Strip tracking params
  const keep: Array<[string, string]> = [];
  for (const [k, v] of u.searchParams) {
    if (!isTrackingParam(k)) keep.push([k, v]);
  }
  // Sort để key ổn định bất kể thứ tự param
  keep.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  // Reset & rebuild
  // Note: URL.searchParams.delete trong loop sẽ confuse iterator → reset bằng cách
  // gán search rỗng rồi append lại.
  u.search = "";
  for (const [k, v] of keep) u.searchParams.append(k, v);

  // Bỏ trailing "/" của path nếu không phải root
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.replace(/\/+$/, "");
  }

  return u.toString();
}
