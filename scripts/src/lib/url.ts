/**
 * Chuẩn hóa URL trước khi dùng làm key dedupe.
 * Mục tiêu: 2 link trỏ về CÙNG bài viết (chỉ khác tracking params hoặc fragment)
 * phải sinh ra cùng key trong storage.
 *
 * Mirror của worker/src/url.ts — giữ 2 file trùng nhau vì Node script
 * không thể import trực tiếp Worker module (khác runtime + bundling).
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

  u.username = "";
  u.password = "";
  u.hostname = u.hostname.toLowerCase();

  if (
    (u.protocol === "http:" && u.port === "80") ||
    (u.protocol === "https:" && u.port === "443")
  ) {
    u.port = "";
  }

  u.hash = "";

  const keep: Array<[string, string]> = [];
  for (const [k, v] of u.searchParams) {
    if (!isTrackingParam(k)) keep.push([k, v]);
  }
  keep.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = "";
  for (const [k, v] of keep) u.searchParams.append(k, v);

  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.replace(/\/+$/, "");
  }

  return u.toString();
}
