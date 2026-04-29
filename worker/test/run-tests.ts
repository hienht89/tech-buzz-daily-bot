/**
 * Tests cho các logic thuần (không chạm Cloudflare runtime).
 *
 * Chạy bằng: `npm test` hoặc `node --experimental-strip-types --test test/run-tests.ts`
 *
 * Chỉ test các module pure/util — không test handler scheduled/fetch vì cần
 * mock KV + Telegram. Mục tiêu: catch regression của các bug đã sửa trong audit.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeUrl } from "../src/url.ts";
import { truncateRawByEscapedBudget } from "../src/telegram.ts";

// ────────────────────────────────────────────────────────────────────────────
// URL normalization (BUG #5: dedupe miss khi link có utm/fbclid khác nhau)
// ────────────────────────────────────────────────────────────────────────────

test("normalizeUrl: same article with different utm params → same key", () => {
  const a = normalizeUrl("https://techcrunch.com/2026/04/29/openai-news/?utm_source=twitter&utm_medium=social");
  const b = normalizeUrl("https://techcrunch.com/2026/04/29/openai-news/?utm_source=facebook");
  const c = normalizeUrl("https://techcrunch.com/2026/04/29/openai-news/");
  assert.equal(a, c);
  assert.equal(b, c);
});

test("normalizeUrl: strips fbclid, gclid, ref", () => {
  const a = normalizeUrl("https://example.com/post?fbclid=abc123&gclid=xyz&ref=newsletter");
  const b = normalizeUrl("https://example.com/post");
  assert.equal(a, b);
});

test("normalizeUrl: strips fragment", () => {
  const a = normalizeUrl("https://example.com/post#comments");
  const b = normalizeUrl("https://example.com/post");
  assert.equal(a, b);
});

test("normalizeUrl: lowercases host but preserves path case", () => {
  const a = normalizeUrl("https://TechCrunch.COM/2026/04/MyArticle");
  assert.match(a, /^https:\/\/techcrunch\.com\/2026\/04\/MyArticle$/);
});

test("normalizeUrl: sorts query params for stable key", () => {
  const a = normalizeUrl("https://example.com/p?b=2&a=1");
  const b = normalizeUrl("https://example.com/p?a=1&b=2");
  assert.equal(a, b);
});

test("normalizeUrl: strips default ports", () => {
  assert.equal(
    normalizeUrl("https://example.com:443/p"),
    normalizeUrl("https://example.com/p"),
  );
  assert.equal(
    normalizeUrl("http://example.com:80/p"),
    normalizeUrl("http://example.com/p"),
  );
});

test("normalizeUrl: removes trailing slash from non-root path", () => {
  assert.equal(
    normalizeUrl("https://example.com/post/"),
    normalizeUrl("https://example.com/post"),
  );
});

test("normalizeUrl: keeps root slash", () => {
  assert.equal(normalizeUrl("https://example.com/"), "https://example.com/");
});

test("normalizeUrl: keeps non-tracking query params", () => {
  const a = normalizeUrl("https://example.com/search?q=ai&page=2&utm_source=x");
  // q và page giữ nguyên, utm_source bị strip
  assert.match(a, /[?&]q=ai/);
  assert.match(a, /[?&]page=2/);
  assert.doesNotMatch(a, /utm_source/);
});

test("normalizeUrl: graceful fallback for invalid URL", () => {
  assert.equal(normalizeUrl("not a url"), "not a url");
  assert.equal(normalizeUrl(""), "");
});

test("normalizeUrl: strips userinfo (security/privacy)", () => {
  const a = normalizeUrl("https://user:pass@example.com/p");
  assert.doesNotMatch(a, /user:pass/);
});

// ────────────────────────────────────────────────────────────────────────────
// HTML-safe truncation (BUG #6: cắt giữa entity → invalid HTML → Telegram reject)
// ────────────────────────────────────────────────────────────────────────────

test("truncateRawByEscapedBudget: short text fits unchanged", () => {
  const out = truncateRawByEscapedBudget("hello world", 1024);
  assert.equal(out, "hello world");
});

test("truncateRawByEscapedBudget: escapes special chars when fitting", () => {
  const out = truncateRawByEscapedBudget("a & b < c > d", 1024);
  assert.equal(out, "a &amp; b &lt; c &gt; d");
});

test("truncateRawByEscapedBudget: respects budget on long text", () => {
  const long = "x".repeat(2000);
  const out = truncateRawByEscapedBudget(long, 100);
  assert.ok(out.length <= 100, `Expected <= 100, got ${out.length}`);
  assert.ok(out.endsWith("..."));
});

test("truncateRawByEscapedBudget: never produces broken HTML entity", () => {
  // Worst case: chuỗi gồm toàn ký tự `&` (escape thành `&amp;` = 5 chars).
  // Nếu cắt nhầm vào giữa 1 entity → output sẽ chứa "&amp" hoặc "&am" hoặc "&a"
  // (không có ;) — Telegram parser sẽ reject.
  const raw = "&".repeat(500);
  for (const budget of [50, 100, 200, 500, 999, 1024]) {
    const out = truncateRawByEscapedBudget(raw, budget);
    assert.ok(out.length <= budget, `budget=${budget}: length ${out.length} > budget`);
    // Mọi ký tự `&` trong output phải mở đầu của 1 entity hợp lệ
    // → kiểm tra không có "&" nào không kèm sau là `amp;`, `lt;`, `gt;` (trong ngữ cảnh test này chỉ có amp;)
    const ampPositions: number[] = [];
    for (let i = 0; i < out.length; i++) {
      if (out[i] === "&") ampPositions.push(i);
    }
    for (const pos of ampPositions) {
      const tail = out.slice(pos, pos + 5); // "&amp;" = 5 chars
      assert.equal(
        tail,
        "&amp;",
        `budget=${budget}: broken entity at pos ${pos} (got "${tail}", full output length ${out.length})`,
      );
    }
  }
});

test("truncateRawByEscapedBudget: handles mix of plain text and entities", () => {
  const raw = "hello & welcome to <Tech> news " + "x".repeat(2000);
  const out = truncateRawByEscapedBudget(raw, 200);
  assert.ok(out.length <= 200);
  // Không có entity bị cắt dở
  const matches = out.match(/&[a-z]*$/);
  if (matches) {
    assert.fail(`Output ends with broken entity: ${matches[0]}`);
  }
});

test("truncateRawByEscapedBudget: ellipsis added when truncated", () => {
  const raw = "x".repeat(500);
  const out = truncateRawByEscapedBudget(raw, 50);
  assert.ok(out.endsWith("..."));
});

test("truncateRawByEscapedBudget: empty string", () => {
  assert.equal(truncateRawByEscapedBudget("", 100), "");
});
