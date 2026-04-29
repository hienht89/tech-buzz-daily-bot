/**
 * Crawl og:image / twitter:image từ trang gốc của bài.
 *
 * LÝ DO TỒN TẠI: nhiều RSS feed (đặc biệt arxiv, một số blog AI lab) KHÔNG
 * embed ảnh trong feed. Trước đây bot fallback về sendMessage không ảnh →
 * post Telegram trông trống trải. Hàm này best-effort fetch HTML trang gốc
 * (với timeout ngắn + giới hạn dung lượng) để tìm meta og:image hoặc
 * twitter:image, rồi promote bài lên dùng sendPhoto.
 *
 * Triết lý:
 * - BEST EFFORT: lỗi (timeout, 404, parse fail, không có meta) → trả undefined,
 *   pipeline phía trên fallback sang sendMessage không ảnh — KHÔNG throw.
 * - NHANH: timeout 5s, đọc tối đa ~200KB head (head meta tag thường nằm trong
 *   ~30KB đầu, để dư phòng case có inline JSON-LD lớn).
 * - AN TOÀN: chỉ chấp nhận URL ảnh tuyệt đối http(s); resolve relative URL
 *   tương đối với trang gốc.
 */

const FETCH_TIMEOUT_MS = 5_000;
const MAX_HTML_BYTES = 200 * 1024;

/**
 * Tìm tất cả meta tag candidate. Order theo priority:
 *   og:image, og:image:secure_url, twitter:image, twitter:image:src
 *
 * Regex match cả 2 thứ tự attribute (property="og:image" content="..." vs
 * content="..." property="og:image"), cả single + double quote, cả
 * `name=` (twitter dùng `name`, og dùng `property` — tuy nhiều site dùng lẫn).
 */
const META_PATTERNS: { name: string; priority: number }[] = [
  { name: "og:image", priority: 0 },
  { name: "og:image:secure_url", priority: 0 },
  { name: "twitter:image", priority: 1 },
  { name: "twitter:image:src", priority: 1 },
];

function extractMetaContent(html: string, metaName: string): string | undefined {
  // Match cả property=... và name=... với nội dung là metaName, lấy content="..."
  // Lưu ý: HTML attribute không phân biệt thứ tự, nên 2 hướng:
  //   <meta property="og:image" content="...">
  //   <meta content="..." property="og:image">
  const escapedName = metaName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:property|name)=["']${escapedName}["'][^>]*?content=["']([^"']+)["']`,
      "i",
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]*?(?:property|name)=["']${escapedName}["']`,
      "i",
    ),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return undefined;
}

/**
 * Resolve relative URL → absolute với base là URL bài.
 * Trả undefined nếu URL không hợp lệ hoặc không phải http(s).
 */
function resolveImageUrl(raw: string, baseUrl: string): string | undefined {
  try {
    // Decode HTML entity phổ biến trong attribute (vd &amp; → &)
    const decoded = raw.replace(/&amp;/g, "&").replace(/&#x2F;/g, "/").replace(/&#47;/g, "/");
    const u = new URL(decoded, baseUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

/**
 * Đọc tối đa MAX_HTML_BYTES từ stream, decode UTF-8 (sai charset → vẫn OK
 * vì meta tag chỉ chứa ASCII trong attribute name + URL).
 */
async function readLimited(res: Response, maxBytes: number): Promise<string> {
  // Workers fetch có thể không hỗ trợ Range với mọi origin → đọc stream và
  // tự cắt. Tránh res.text() vì nó đọc toàn bộ.
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.length;
      }
    }
  } finally {
    // Luôn cancel để giải phóng connection
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
  // Concat
  const merged = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const c of chunks) {
    const remain = merged.length - offset;
    if (remain <= 0) break;
    const slice = c.length > remain ? c.subarray(0, remain) : c;
    merged.set(slice, offset);
    offset += slice.length;
  }
  return new TextDecoder("utf-8").decode(merged);
}

/**
 * Best-effort fetch og:image. Mọi lỗi → trả undefined, không throw.
 */
export async function extractOgImage(articleUrl: string): Promise<string | undefined> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(articleUrl, {
      signal: controller.signal,
      headers: {
        // Bot-friendly UA, nhiều site block default fetch UA
        "User-Agent":
          "Mozilla/5.0 (compatible; TechBuzzBot/1.0; +https://t.me/techbuzz_daily)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      cf: { cacheTtl: 600, cacheEverything: true } as RequestInit["cf"],
      redirect: "follow",
    });
    if (!res.ok) {
      console.log(`[og] ${articleUrl} → HTTP ${res.status}, skip`);
      return undefined;
    }
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.toLowerCase().includes("html")) {
      console.log(`[og] ${articleUrl} → not html (${ct}), skip`);
      return undefined;
    }
    const html = await readLimited(res, MAX_HTML_BYTES);
    if (!html) return undefined;

    // Cắt phần <head>...</head> nếu có để giảm regex range.
    // Không bắt buộc — meta tag thường nằm trong head.
    const headEnd = html.search(/<\/head>/i);
    const haystack = headEnd > 0 ? html.slice(0, headEnd) : html;

    for (const { name } of META_PATTERNS) {
      const raw = extractMetaContent(haystack, name);
      if (raw) {
        const resolved = resolveImageUrl(raw, res.url || articleUrl);
        if (resolved) {
          console.log(`[og] ${articleUrl} → found ${name}`);
          return resolved;
        }
      }
    }
    console.log(`[og] ${articleUrl} → no og:image meta found`);
    return undefined;
  } catch (err) {
    console.log(
      `[og] ${articleUrl} → error: ${(err as Error).message?.slice(0, 100)}`,
    );
    return undefined;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Helpers exported for unit testing only.
 */
export const __test = {
  extractMetaContent,
  resolveImageUrl,
};
