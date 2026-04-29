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
import { __test as ogTest } from "../src/og.ts";

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

// ────────────────────────────────────────────────────────────────────────────
// og:image extraction (cứu cánh khi RSS không kèm ảnh — vd arxiv)
// ────────────────────────────────────────────────────────────────────────────

test("og: extract og:image với property trước content", () => {
  const html = `<html><head>
    <meta property="og:image" content="https://example.com/cover.jpg">
  </head></html>`;
  assert.equal(ogTest.extractMetaContent(html, "og:image"), "https://example.com/cover.jpg");
});

test("og: extract og:image với content trước property (thứ tự ngược)", () => {
  const html = `<meta content="https://cdn.com/x.png" property="og:image">`;
  assert.equal(ogTest.extractMetaContent(html, "og:image"), "https://cdn.com/x.png");
});

test("og: extract twitter:image với name= thay vì property=", () => {
  const html = `<meta name="twitter:image" content="https://t.com/img.jpg">`;
  assert.equal(ogTest.extractMetaContent(html, "twitter:image"), "https://t.com/img.jpg");
});

test("og: extract single quote attribute", () => {
  const html = `<meta property='og:image' content='https://e.com/y.jpg'>`;
  assert.equal(ogTest.extractMetaContent(html, "og:image"), "https://e.com/y.jpg");
});

test("og: không match khi meta tag khác (priority isolation)", () => {
  const html = `<meta property="og:title" content="Hello">`;
  assert.equal(ogTest.extractMetaContent(html, "og:image"), undefined);
});

test("og: resolveImageUrl absolute giữ nguyên", () => {
  assert.equal(
    ogTest.resolveImageUrl("https://cdn.com/a.jpg", "https://example.com/post"),
    "https://cdn.com/a.jpg",
  );
});

test("og: resolveImageUrl relative resolve theo base", () => {
  assert.equal(
    ogTest.resolveImageUrl("/static/cover.jpg", "https://example.com/blog/post"),
    "https://example.com/static/cover.jpg",
  );
});

test("og: resolveImageUrl protocol-relative", () => {
  assert.equal(
    ogTest.resolveImageUrl("//cdn.com/img.jpg", "https://example.com/post"),
    "https://cdn.com/img.jpg",
  );
});

test("og: resolveImageUrl decode &amp; trong URL", () => {
  assert.equal(
    ogTest.resolveImageUrl("https://cdn.com/a.jpg?w=1&amp;h=2", "https://example.com/"),
    "https://cdn.com/a.jpg?w=1&h=2",
  );
});

test("og: resolveImageUrl reject non-http(s) (vd data:, javascript:)", () => {
  assert.equal(ogTest.resolveImageUrl("javascript:alert(1)", "https://example.com/"), undefined);
  assert.equal(ogTest.resolveImageUrl("data:image/png;base64,xxx", "https://example.com/"), undefined);
});

test("og: resolveImageUrl invalid URL → undefined (không throw)", () => {
  assert.equal(ogTest.resolveImageUrl("", "not-a-valid-base"), undefined);
});

// ────────────────────────────────────────────────────────────────────────────
// Phase 2: filter (keyword scoring + arxiv strict)
// ────────────────────────────────────────────────────────────────────────────

import { keywordScore, isRelevantArxivPaper } from "../src/filter.ts";

test("filter.keywordScore: bài có boost keyword được +điểm, không có penalty → 0", () => {
  const r = keywordScore("OpenAI launches GPT-5 model", "Open source release with new benchmark");
  assert.ok(r.boost > 0, "phải có boost");
  assert.equal(r.penalty, 0);
});

test("filter.keywordScore: bài review/leak bị penalty", () => {
  const r = keywordScore("iPhone 17 review and leaked specs", "");
  assert.ok(r.penalty > 0, "phải bị penalty");
});

test("filter.keywordScore: cap không vượt quá BOOST_CAP/PENALTY_CAP", () => {
  // Dồn nhiều từ để chắc chắn vượt cap
  const r = keywordScore(
    "openai anthropic deepmind nvidia model launch release benchmark security vulnerability outage breach github postgres rust typescript",
    "open source agent agentic inference training fine-tune multimodal embedding transformer",
  );
  assert.ok(r.boost <= 30, `boost ${r.boost} phải ≤ cap 30`);
});

test("filter.isRelevantArxivPaper: paper LLM → pass", () => {
  assert.equal(isRelevantArxivPaper("Improving LLM reasoning with chain-of-thought"), true);
  assert.equal(isRelevantArxivPaper("Diffusion models for video generation"), true);
});

test("filter.isRelevantArxivPaper: paper toán thuần → reject", () => {
  assert.equal(isRelevantArxivPaper("Stochastic Gradient on Riemannian Manifolds"), false);
  assert.equal(isRelevantArxivPaper("Bayesian inference with Monte Carlo"), false);
});

// ────────────────────────────────────────────────────────────────────────────
// Phase 3: score
// ────────────────────────────────────────────────────────────────────────────

import { scoreArticle, formatBreakdown } from "../src/score.ts";
import type { Article } from "../src/rss.ts";

function mkArticle(over: Partial<Article> = {}): Article {
  return {
    title: "Sample title",
    link: "https://example.com/post",
    canonicalUrl: "https://example.com/post",
    pubDate: new Date(),
    source: "TechCrunch",
    sourceCategory: "core",
    sourcePriority: 2,
    contentSnippet: "Short snippet",
    ...over,
  };
}

test("score: source priority 1 > 2 > 3", () => {
  const now = new Date("2026-04-29T12:00:00Z");
  const fixedDate = new Date("2026-04-29T11:00:00Z");
  const a1 = scoreArticle(mkArticle({ sourcePriority: 1, pubDate: fixedDate }), now);
  const a2 = scoreArticle(mkArticle({ sourcePriority: 2, pubDate: fixedDate }), now);
  const a3 = scoreArticle(mkArticle({ sourcePriority: 3, pubDate: fixedDate }), now);
  assert.ok(a1.source > a2.source, "P1 > P2");
  assert.ok(a2.source > a3.source, "P2 > P3");
});

test("score: recency decays linearly đến 0 ở 48h", () => {
  const now = new Date("2026-04-29T12:00:00Z");
  const fresh = scoreArticle(mkArticle({ pubDate: now }), now);
  const old = scoreArticle(
    mkArticle({ pubDate: new Date(now.getTime() - 48 * 3600 * 1000) }),
    now,
  );
  assert.equal(fresh.recency, 100);
  assert.equal(old.recency, 0);
});

test("score: HN bị penalty vs source khác", () => {
  const now = new Date();
  const fixed = new Date(now.getTime() - 3600 * 1000);
  const hn = scoreArticle(mkArticle({ source: "Hacker News", pubDate: fixed, sourcePriority: 3 }), now);
  const tc = scoreArticle(mkArticle({ source: "TechCrunch", pubDate: fixed, sourcePriority: 3 }), now);
  assert.ok(hn.hnPenalty > 0);
  assert.ok(hn.total < tc.total, "HN total phải nhỏ hơn TechCrunch khi cùng priority");
});

test("score: primary lab boost cho OpenAI Blog", () => {
  const now = new Date();
  const fixed = new Date(now.getTime() - 3600 * 1000);
  const lab = scoreArticle(
    mkArticle({ source: "OpenAI Blog", pubDate: fixed, sourcePriority: 1 }),
    now,
  );
  assert.ok(lab.primaryLab > 0);
});

test("score: depth boost khi snippet dài ≥ 500 chars", () => {
  const now = new Date();
  const fixed = new Date(now.getTime() - 3600 * 1000);
  const long = "a".repeat(600);
  const r = scoreArticle(mkArticle({ contentSnippet: long, pubDate: fixed }), now);
  assert.ok(r.depth > 0);
});

test("score.formatBreakdown trả string có total", () => {
  const now = new Date();
  const r = scoreArticle(mkArticle({ pubDate: now }), now);
  const s = formatBreakdown(r);
  assert.match(s, /→ -?\d+/);
});

// Phase 11: per-domain trust
test("score: domain trust boost cho openai.com (suffix match)", () => {
  const now = new Date();
  const fixed = new Date(now.getTime() - 3600 * 1000);
  const r = scoreArticle(
    mkArticle({
      link: "https://news.openai.com/post/abc",
      canonicalUrl: "https://news.openai.com/post/abc",
      source: "OpenAI Blog", // primaryLab cũng cộng — verify cả 2 stack được
      sourcePriority: 1,
      pubDate: fixed,
    }),
    now,
  );
  assert.ok(r.domainTrust > 0, "domain openai.com phải có trust > 0");
  assert.equal(r.domainBlock, 0, "openai.com không bị block");
});

test("score: blocked domain bị penalty rất lớn → total âm", () => {
  const now = new Date();
  const fixed = new Date(now.getTime() - 3600 * 1000);
  const r = scoreArticle(
    mkArticle({
      link: "https://www.androidauthority.com/some-article",
      canonicalUrl: "https://www.androidauthority.com/some-article",
      source: "TechCrunch", // không phải lab nhưng vẫn priority 2
      sourcePriority: 2,
      pubDate: fixed,
    }),
    now,
  );
  assert.ok(r.domainBlock > 0, "androidauthority.com phải bị block");
  assert.ok(r.total < 0, "total phải âm sau penalty (đảm bảo không bao giờ pick)");
});

test("score: domain không nằm trong table → trust = 0, không crash", () => {
  const now = new Date();
  const fixed = new Date(now.getTime() - 3600 * 1000);
  const r = scoreArticle(
    mkArticle({
      link: "https://random-blog-xyz.com/post",
      canonicalUrl: "https://random-blog-xyz.com/post",
      pubDate: fixed,
    }),
    now,
  );
  assert.equal(r.domainTrust, 0);
  assert.equal(r.domainBlock, 0);
});

test("score: URL không parse được → domain rỗng, không crash", () => {
  const now = new Date();
  const r = scoreArticle(
    mkArticle({
      link: "not-a-valid-url",
      canonicalUrl: "not-a-valid-url",
      pubDate: now,
    }),
    now,
  );
  assert.equal(r.domainTrust, 0);
  assert.equal(r.domainBlock, 0);
});

// ────────────────────────────────────────────────────────────────────────────
// Phase 4: dedup
// ────────────────────────────────────────────────────────────────────────────

import {
  normalizeTitle,
  trigrams,
  jaccard,
  checkFuzzyDuplicate,
  clusterBatch,
  FUZZY_THRESHOLD,
  type RecentTitleEntry,
} from "../src/dedup.ts";

test("dedup.normalizeTitle: lower + drop punctuation + drop stop word", () => {
  const n = normalizeTitle("OpenAI's GPT-5 is launched in the US!");
  // 'is', 'in', 'the' bị drop; apostrophe → space nên 'openai' và 's' tách ra
  assert.equal(n, "openai s gpt 5 launched us");
});

test("dedup.trigrams + jaccard: 2 chuỗi giống nhau → ≈ 1", () => {
  const a = trigrams("openai launches gpt5");
  const b = trigrams("openai launches gpt5");
  assert.equal(jaccard(a, b), 1);
});

test("dedup.jaccard: chuỗi khác hoàn toàn → thấp", () => {
  const a = trigrams("openai launches gpt5");
  const b = trigrams("apple unveils new mac mini");
  assert.ok(jaccard(a, b) < 0.2, `expected low jaccard, got ${jaccard(a, b)}`);
});

test("dedup.checkFuzzyDuplicate: title gần giống recent → duplicate", () => {
  const recentTitle = "OpenAI launches GPT-5 with improved reasoning capabilities for agents";
  const recent: RecentTitleEntry[] = [
    {
      raw: recentTitle,
      norm: normalizeTitle(recentTitle),
      postedAt: new Date().toISOString(),
    },
  ];
  // chỉ thêm 1 từ "today" → jaccard ≥ 0.88
  const r = checkFuzzyDuplicate(
    recentTitle + " today",
    recent,
  );
  assert.equal(r.duplicate, true);
  if (r.duplicate) assert.ok(r.similarity >= FUZZY_THRESHOLD);
});

test("dedup.checkFuzzyDuplicate: title khác → không duplicate", () => {
  const recent: RecentTitleEntry[] = [
    {
      raw: "OpenAI launches GPT-5",
      norm: normalizeTitle("OpenAI launches GPT-5"),
      postedAt: new Date().toISOString(),
    },
  ];
  const r = checkFuzzyDuplicate("Apple unveils new Mac mini", recent);
  assert.equal(r.duplicate, false);
});

test("dedup.clusterBatch: 2 bài cùng event → giữ 1 winner (priority thấp hơn thắng)", () => {
  // 2 title gần như identical (chỉ khác đuôi "today") → jaccard ≥ 0.80
  const winner = mkArticle({
    title: "OpenAI launches GPT-5 with reasoning improvements",
    source: "OpenAI Blog",
    sourcePriority: 1,
    score: 200,
  });
  const loser = mkArticle({
    title: "OpenAI launches GPT-5 with reasoning improvements today",
    source: "TechCrunch",
    sourcePriority: 2,
    score: 150,
  });
  const out = clusterBatch([loser, winner]);
  assert.equal(out.length, 1);
  assert.equal(out[0].source, "OpenAI Blog");
});

test("dedup.clusterBatch: 2 bài event khác nhau → giữ cả 2", () => {
  const a = mkArticle({ title: "OpenAI launches GPT-5" });
  const b = mkArticle({ title: "Apple unveils new Mac mini chip" });
  const out = clusterBatch([a, b]);
  assert.equal(out.length, 2);
});

// ────────────────────────────────────────────────────────────────────────────
// Phase 5: bucket
// ────────────────────────────────────────────────────────────────────────────

import {
  selectFromBuckets,
  DEFAULT_QUOTA,
  todayKeyUTC,
  formatUsage,
} from "../src/bucket.ts";

test("bucket.todayKeyUTC: format YYYY-MM-DD theo UTC", () => {
  const k = todayKeyUTC(new Date("2026-04-29T15:30:00Z"));
  assert.equal(k, "2026-04-29");
});

test("bucket.selectFromBuckets: chọn highest score trong bucket còn quota", () => {
  const candidates: Article[] = [
    mkArticle({ title: "core1", sourceCategory: "core", score: 180 }),
    mkArticle({ title: "core2", sourceCategory: "core", score: 200 }),
    mkArticle({ title: "trend1", sourceCategory: "trend", score: 250 }),
  ];
  const usage = { core: 0, ai: 0, dev: 0, research: 0, trend: 0 };
  const r = selectFromBuckets(candidates, usage);
  assert.equal(r.fallback, false);
  // trend1 có score cao nhất và còn quota → thắng
  assert.equal(r.picked?.title, "trend1");
});

test("bucket.selectFromBuckets: bucket đầy → skip, chọn từ bucket khác", () => {
  const candidates: Article[] = [
    mkArticle({ title: "trend1", sourceCategory: "trend", score: 250 }),
    mkArticle({ title: "core1", sourceCategory: "core", score: 200 }),
  ];
  // trend đã đầy 2/2 → phải chọn core1
  const usage = { core: 0, ai: 0, dev: 0, research: 0, trend: 2 };
  const r = selectFromBuckets(candidates, usage);
  assert.equal(r.fallback, false);
  assert.equal(r.picked?.title, "core1");
});

test("bucket.selectFromBuckets: tất cả bucket đầy → fallback highest score", () => {
  const candidates: Article[] = [
    mkArticle({ title: "low", sourceCategory: "core", score: 100 }),
    mkArticle({ title: "high", sourceCategory: "ai", score: 300 }),
  ];
  const usage = { ...DEFAULT_QUOTA }; // dùng quota làm usage = đầy
  const r = selectFromBuckets(candidates, usage);
  assert.equal(r.fallback, true);
  assert.equal(r.picked?.title, "high");
});

test("bucket.selectFromBuckets: empty candidates → null", () => {
  const r = selectFromBuckets([], { core: 0, ai: 0, dev: 0, research: 0, trend: 0 });
  assert.equal(r.picked, null);
});

test("bucket.formatUsage: hiện full marker khi đầy", () => {
  // Quota mặc định Phase 15: core=6 → cần usage=6 để full
  const s = formatUsage({ core: 6, ai: 1, dev: 0, research: 0, trend: 0 });
  assert.match(s, /core 6\/6\(full\)/);
  assert.match(s, /ai 1\/5/);
});

// ────────────────────────────────────────────────────────────────────────────
// Phase 6: telegram caption format mới (bullets + whyItMatters)
// ────────────────────────────────────────────────────────────────────────────

import { __test as telegramTest } from "../src/telegram.ts";

test("telegram.formatCaption: render bullets + 'Vì sao đáng đọc' + link", () => {
  const article = mkArticle({
    title: "Original",
    link: "https://example.com/post",
    source: "OpenAI Blog",
  });
  const summary = {
    title: "🚀 GPT-5 ra mắt",
    bullets: ["Hỗ trợ context 10M tokens", "Reasoning tốt hơn 30%"],
    whyItMatters: "Đặt chuẩn mới cho LLM thương mại.",
  };
  const env = {
    TELEGRAM_CHANNEL_ID: "@techbuzz_daily",
    TELEGRAM_SIGNATURE: "Tech Buzz Daily",
    TELEGRAM_SIGNATURE_EMOJI: "🐝",
  } as any;
  const out = telegramTest.formatCaption(article, summary, env, 1024);
  assert.match(out, /<b>🚀 GPT-5 ra mắt<\/b>/);
  assert.match(out, /• Hỗ trợ context 10M tokens/);
  assert.match(out, /• Reasoning tốt hơn 30%/);
  assert.match(out, /Vì sao đáng đọc:/);
  assert.match(out, /https:\/\/example\.com\/post/);
});

test("telegram.formatCaption: HTML escape trong title bullet why", () => {
  const article = mkArticle({ link: "https://example.com/p" });
  const summary = {
    title: "<script>alert(1)</script>",
    bullets: ["A & B < C"],
    whyItMatters: "X > Y",
  };
  const env = { TELEGRAM_CHANNEL_ID: "@x" } as any;
  const out = telegramTest.formatCaption(article, summary, env, 1024);
  assert.ok(!out.includes("<script>"), "không được giữ <script> raw");
  assert.match(out, /A &amp; B &lt; C/);
  assert.match(out, /X &gt; Y/);
});

// ────────────────────────────────────────────────────────────────────────────
// Phase 6: ai parsing — schema mới + backward compat schema cũ
// ────────────────────────────────────────────────────────────────────────────

import { __test as aiTest } from "../src/ai.ts";

test("ai.tryParseSummary: schema mới { title, bullets, whyItMatters }", () => {
  const raw = JSON.stringify({
    title: "🚀 GPT-5",
    bullets: ["bullet 1", "bullet 2"],
    whyItMatters: "Vì sao quan trọng",
  });
  const r = aiTest.tryParseSummary(raw);
  assert.ok(r);
  assert.equal(r!.title, "🚀 GPT-5");
  assert.equal(r!.bullets.length, 2);
  assert.equal(r!.whyItMatters, "Vì sao quan trọng");
});

test("ai.tryParseSummary: bullets sanitize bỏ marker '-' '•' '*'", () => {
  const raw = JSON.stringify({
    title: "T",
    bullets: ["- một", "• hai", "* ba"],
    whyItMatters: "why",
  });
  const r = aiTest.tryParseSummary(raw);
  assert.ok(r);
  assert.deepEqual(r!.bullets, ["một", "hai", "ba"]);
});

test("ai.tryParseSummary: schema cũ { body, takeaway } → convert sang bullets", () => {
  const raw = JSON.stringify({
    title: "T",
    body: "Câu một. Câu hai. Câu ba.",
    takeaway: "Insight",
  });
  const r = aiTest.tryParseSummary(raw);
  assert.ok(r);
  assert.equal(r!.bullets.length, 3);
  assert.equal(r!.whyItMatters, "Insight");
});

test("ai.tryParseSummary: code fence ```json bị strip", () => {
  const raw = "```json\n" +
    JSON.stringify({ title: "T", bullets: ["a"], whyItMatters: "w" }) +
    "\n```";
  const r = aiTest.tryParseSummary(raw);
  assert.ok(r);
  assert.equal(r!.title, "T");
});

test("ai.tryParseSummary: thiếu field → null", () => {
  assert.equal(aiTest.tryParseSummary(JSON.stringify({ title: "x" })), null);
  assert.equal(aiTest.tryParseSummary("not json"), null);
});

// ────────────────────────────────────────────────────────────────────────────
// Phase 9: AI provider chain — classifyHttpError + provider list
// ────────────────────────────────────────────────────────────────────────────

test("ai.classifyHttpError: 429 → fatal (quota)", () => {
  assert.equal(aiTest.classifyHttpError(429).fatal, true);
});

test("ai.classifyHttpError: 401/403 → fatal (auth)", () => {
  assert.equal(aiTest.classifyHttpError(401).fatal, true);
  assert.equal(aiTest.classifyHttpError(403).fatal, true);
});

test("ai.classifyHttpError: 5xx → non-fatal (retry)", () => {
  assert.equal(aiTest.classifyHttpError(500).fatal, false);
  assert.equal(aiTest.classifyHttpError(502).fatal, false);
  assert.equal(aiTest.classifyHttpError(503).fatal, false);
  assert.equal(aiTest.classifyHttpError(504).fatal, false);
});

test("ai.classifyHttpError: 400/404 → fatal (bad request)", () => {
  assert.equal(aiTest.classifyHttpError(400).fatal, true);
  assert.equal(aiTest.classifyHttpError(404).fatal, true);
});

test("ai.collectGeminiKeys: gom GOOGLE_API_KEY (k0) + _1.._5 theo thứ tự", () => {
  assert.deepEqual(aiTest.collectGeminiKeys({} as any), []);
  assert.deepEqual(aiTest.collectGeminiKeys({ GOOGLE_API_KEY: "a" } as any), [
    { slug: "k0", key: "a" },
  ]);
  const three = aiTest.collectGeminiKeys({
    GOOGLE_API_KEY: "a",
    GOOGLE_API_KEY_1: "b",
    GOOGLE_API_KEY_2: "c",
  } as any);
  assert.deepEqual(three, [
    { slug: "k0", key: "a" },
    { slug: "k1", key: "b" },
    { slug: "k2", key: "c" },
  ]);
  // Skip key trống/missing nhưng giữ thứ tự
  const sparse = aiTest.collectGeminiKeys({
    GOOGLE_API_KEY: "a",
    GOOGLE_API_KEY_2: "c",
  } as any);
  assert.deepEqual(sparse, [
    { slug: "k0", key: "a" },
    { slug: "k2", key: "c" },
  ]);
});

test("ai.getProviders: chỉ 1 key Gemini → tên giữ cũ (không suffix)", () => {
  const ps = aiTest.getProviders({ GOOGLE_API_KEY: "a" } as any);
  const names = ps.map((p: { name: string }) => p.name);
  assert.deepEqual(names, ["gemini-2.5-flash", "gemini-2.0-flash"]);
});

test("ai.getProviders: nhiều key Gemini → suffix #kN, ưu tiên 2.5 trước 2.0", () => {
  const ps = aiTest.getProviders({
    GOOGLE_API_KEY: "a",
    GOOGLE_API_KEY_1: "b",
  } as any);
  const names = ps.map((p: { name: string }) => p.name);
  // Tất cả 2.5 trước, rồi tất cả 2.0 — để xài hết quota model tốt trước
  assert.deepEqual(names, [
    "gemini-2.5-flash#k0",
    "gemini-2.5-flash#k1",
    "gemini-2.0-flash#k0",
    "gemini-2.0-flash#k1",
  ]);
});

test("ai.getProviders: thêm OR_KEY → 2 OR providers nối cuối chain", () => {
  const ps = aiTest.getProviders({
    GOOGLE_API_KEY: "a",
    OPENROUTER_API_KEY: "or",
  } as any);
  const names = ps.map((p: { name: string }) => p.name);
  assert.deepEqual(names, [
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "openrouter-llama",
    "openrouter-gemma",
  ]);
});

test("ai.getProviders: env trống → 0 providers", () => {
  assert.equal(aiTest.getProviders({} as any).length, 0);
});

test("ai.getProviders: provider names unique trong Set → circuit breaker #k0 không kill #k1", () => {
  // Contract của circuit breaker (deadProviders Set<string> trong summarizeArticle):
  // mỗi (key × model) phải có name riêng để mark dead 1 cái không ảnh hưởng cái kia.
  const ps = aiTest.getProviders({
    GOOGLE_API_KEY: "a",
    GOOGLE_API_KEY_1: "b",
    GOOGLE_API_KEY_2: "c",
    OPENROUTER_API_KEY: "or",
  } as any);
  const names = ps.map((p: { name: string }) => p.name);
  const unique = new Set(names);
  assert.equal(unique.size, names.length, "tên provider phải unique");
  // Simulate circuit breaker: mark #k0 cho cả 2 model dead → #k1, #k2 vẫn còn sống
  const dead = new Set<string>(["gemini-2.5-flash#k0", "gemini-2.0-flash#k0"]);
  const alive = ps.filter((p: { name: string }) => !dead.has(p.name)).map((p: { name: string }) => p.name);
  assert.deepEqual(alive, [
    "gemini-2.5-flash#k1",
    "gemini-2.5-flash#k2",
    "gemini-2.0-flash#k1",
    "gemini-2.0-flash#k2",
    "openrouter-llama",
    "openrouter-gemma",
  ]);
});

test("ai.getProviders: full chain 3 key Gemini + OR = 8 providers", () => {
  const ps = aiTest.getProviders({
    GOOGLE_API_KEY: "a",
    GOOGLE_API_KEY_1: "b",
    GOOGLE_API_KEY_2: "c",
    OPENROUTER_API_KEY: "or",
  } as any);
  assert.equal(ps.length, 8);
  const names = ps.map((p: { name: string }) => p.name);
  assert.deepEqual(names, [
    "gemini-2.5-flash#k0",
    "gemini-2.5-flash#k1",
    "gemini-2.5-flash#k2",
    "gemini-2.0-flash#k0",
    "gemini-2.0-flash#k1",
    "gemini-2.0-flash#k2",
    "openrouter-llama",
    "openrouter-gemma",
  ]);
});

test("ai.ProviderError: fatal flag được giữ", () => {
  const e = new aiTest.ProviderError("test", 429, true);
  assert.equal(e.fatal, true);
  assert.equal(e.status, 429);
});

test("ai.classifyHttpError: 408 → non-fatal (timeout retryable)", () => {
  assert.equal(aiTest.classifyHttpError(408).fatal, false);
});

// ────────────────────────────────────────────────────────────────────────────
// Phase 16: probeProviders (powers /diag_ai endpoint)
// ────────────────────────────────────────────────────────────────────────────

import { probeProviders, type DiagProviderResult } from "../src/diag.ts";

const stubArticle = {
  title: "stub",
  link: "https://example.com/x",
  canonicalUrl: "https://example.com/x",
  pubDate: new Date(),
  contentSnippet: "stub content",
  source: "stub",
  sourceCategory: "core" as const,
  sourcePriority: 1,
};

test("probeProviders: returns 1 entry per provider (shape contract)", async () => {
  const providers = [
    { name: "p1", call: async () => "result-1" },
    { name: "p2", call: async () => "result-22" },
  ];
  const results: DiagProviderResult[] = await probeProviders(providers, stubArticle);
  assert.equal(results.length, 2);
  assert.equal(results[0].provider, "p1");
  assert.equal(results[0].ok, true);
  assert.equal(results[0].previewBytes, 8); // "result-1".length
  assert.equal(results[1].provider, "p2");
  assert.equal(results[1].ok, true);
  assert.equal(results[1].previewBytes, 9); // "result-22".length
  assert.equal(typeof results[0].ms, "number");
});

test("probeProviders: catches per-provider error WITHOUT breaking loop", async () => {
  const providers = [
    { name: "fail-first", call: async () => { throw new Error("boom 429 quota exhausted"); } },
    { name: "still-runs", call: async () => "ok" },
    { name: "fail-last", call: async () => { throw new Error("network down"); } },
  ];
  const results = await probeProviders(providers, stubArticle);
  assert.equal(results.length, 3, "all 3 providers must be probed even when 1 throws");
  assert.equal(results[0].ok, false);
  assert.match(results[0].error ?? "", /boom 429 quota/);
  assert.equal(results[1].ok, true);
  assert.equal(results[1].previewBytes, 2);
  assert.equal(results[2].ok, false);
  assert.match(results[2].error ?? "", /network down/);
});

test("probeProviders: error message truncated to 400 chars", async () => {
  const longMsg = "x".repeat(800);
  const providers = [
    { name: "verbose-fail", call: async () => { throw new Error(longMsg); } },
  ];
  const results = await probeProviders(providers, stubArticle);
  assert.equal(results[0].ok, false);
  assert.equal(results[0].error?.length, 400, "long errors must be truncated to 400");
});

test("probeProviders: empty provider list → empty result (no crash)", async () => {
  const results = await probeProviders([], stubArticle);
  assert.deepEqual(results, []);
});
