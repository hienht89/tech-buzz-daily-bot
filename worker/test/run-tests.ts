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
  // Phase 17: cần ≥2 distinct non-overlap keyword
  // "LLM reasoning chain-of-thought" → llm + reasoning = 2 distinct ✓
  assert.equal(isRelevantArxivPaper("Improving LLM reasoning with chain-of-thought"), true);
  // "Diffusion models for video generation" → diffusion + video generation = 2 ✓
  assert.equal(isRelevantArxivPaper("Diffusion models for video generation"), true);
});

test("filter.isRelevantArxivPaper: paper toán thuần → reject", () => {
  assert.equal(isRelevantArxivPaper("Stochastic Gradient on Riemannian Manifolds"), false);
  assert.equal(isRelevantArxivPaper("Bayesian inference with Monte Carlo"), false);
});

// ────────────────────────────────────────────────────────────────────────────
// Phase 17: news verb boost, fluff penalty, arxiv ≥2 keyword strict
// ────────────────────────────────────────────────────────────────────────────

test("filter.keywordScore: news verb 'launches' cộng newsVerbBoost > 0", () => {
  const r = keywordScore("Acme launches new platform", "");
  assert.ok(r.newsVerbBoost > 0, `expected newsVerbBoost > 0, got ${r.newsVerbBoost}`);
  // Generic boost không nên nhận từ "launches" nữa (đã chuyển sang NEWS_VERB)
});

test("filter.keywordScore: 'open source' / 'raises' / 'acquires' đều là news verb", () => {
  const a = keywordScore("Vercel open sources its v0 model", "");
  const b = keywordScore("Anthropic raises $5B in Series F", "");
  const c = keywordScore("Stripe acquires Bridge for stablecoin payments", "");
  assert.ok(a.newsVerbBoost > 0);
  assert.ok(b.newsVerbBoost > 0);
  assert.ok(c.newsVerbBoost > 0);
});

test("filter.keywordScore: news verb cap không vượt NEWS_VERB_CAP", () => {
  // Spam nhiều verb để vượt cap
  const r = keywordScore(
    "launches launched released releases announces announced raises raised acquires open source",
    "generally available general availability",
  );
  assert.ok(r.newsVerbBoost <= 40, `news verb boost ${r.newsVerbBoost} phải ≤ cap 40`);
});

test("filter.keywordScore: fluff 'celebrating' + 'anniversary' bị penalty", () => {
  const r = keywordScore("Celebrating 20 years of Google Translate", "Anniversary post");
  assert.ok(r.fluffPenalty > 0, `expected fluffPenalty > 0, got ${r.fluffPenalty}`);
});

test("filter.keywordScore: fluff 'X years' regex match", () => {
  const r = keywordScore("Looking back at 10 years of Kubernetes", "");
  assert.ok(r.fluffPenalty > 0, "regex \\d+ years phải match");
});

test("filter.keywordScore: fluff 'for beginners' / 'getting started' / 'what is' bị penalty", () => {
  assert.ok(keywordScore("GitHub for Beginners: Markdown", "").fluffPenalty > 0);
  assert.ok(keywordScore("Getting started with Rust", "").fluffPenalty > 0);
  assert.ok(keywordScore("What is RAG?", "").fluffPenalty > 0);
});

test("filter.keywordScore: bài news không bị fluff penalty", () => {
  const r = keywordScore("OpenAI launches GPT-5 with improved reasoning", "");
  assert.equal(r.fluffPenalty, 0);
  assert.ok(r.newsVerbBoost > 0);
});

test("filter.isRelevantArxivPaper: chỉ 1 keyword → reject (Phase 17)", () => {
  // SoccerRef-Agents: chỉ match "agent" → reject
  assert.equal(
    isRelevantArxivPaper("SoccerRef-Agents: Multi-Agent Soccer Refereeing"),
    false,
    "chỉ match 'agent' → phải reject",
  );
});

test("filter.isRelevantArxivPaper: ≥2 distinct keyword → pass", () => {
  // "LLM agent" → llm + agent = 2 distinct ✓
  assert.equal(isRelevantArxivPaper("Building LLM agents for code generation"), true);
});

test("filter.isRelevantArxivPaper: nested keyword không double-count", () => {
  // "Large language model" chứa "language model" — chỉ tính 1 hit, không phải 2
  // → cần keyword khác mới đủ 2
  assert.equal(
    isRelevantArxivPaper("Large language model alignment"),
    true, // alignment + language model = 2 distinct ✓
  );
  // Chỉ có "Language model" alone không đủ
  assert.equal(
    isRelevantArxivPaper("Language model architectures"),
    false,
    "chỉ 1 distinct keyword 'language model' → reject",
  );
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

// Phase 17: news verb boost / fluff penalty / path penalty integration
test("score: news verb boost cộng vào total", () => {
  const now = new Date();
  const fixed = new Date(now.getTime() - 3600 * 1000);
  const news = scoreArticle(
    mkArticle({
      title: "Anthropic launches Claude 4 with multimodal reasoning",
      pubDate: fixed,
    }),
    now,
  );
  const baseline = scoreArticle(
    mkArticle({
      title: "Some unrelated topic about water cooler chats",
      pubDate: fixed,
    }),
    now,
  );
  assert.ok(news.newsVerbBoost > 0);
  assert.ok(news.total > baseline.total, "news verb article phải tổng cao hơn");
});

test("score: fluff penalty kéo total xuống", () => {
  const now = new Date();
  const fixed = new Date(now.getTime() - 3600 * 1000);
  const fluff = scoreArticle(
    mkArticle({
      title: "Celebrating 20 years of Google Translate",
      source: "Google AI Blog",
      sourcePriority: 1,
      pubDate: fixed,
    }),
    now,
  );
  const news = scoreArticle(
    mkArticle({
      title: "Google launches new Gemini model with vision",
      source: "Google AI Blog",
      sourcePriority: 1,
      pubDate: fixed,
    }),
    now,
  );
  assert.ok(fluff.fluffPenalty > 0, "fluff phải bị penalty");
  assert.ok(
    news.total > fluff.total,
    `news total ${news.total} phải > fluff total ${fluff.total}`,
  );
});

test("score: vercel.com/changelog/* bị path penalty", () => {
  const now = new Date();
  const fixed = new Date(now.getTime() - 3600 * 1000);
  const r = scoreArticle(
    mkArticle({
      link: "https://vercel.com/changelog/ai-sdk-5-0-released",
      canonicalUrl: "https://vercel.com/changelog/ai-sdk-5-0-released",
      source: "Vercel Blog",
      sourcePriority: 2,
      pubDate: fixed,
    }),
    now,
  );
  assert.ok(r.pathPenalty > 0, `vercel changelog phải pathPenalty > 0, got ${r.pathPenalty}`);
});

test("score: vercel.com gốc (không phải /changelog) → no path penalty", () => {
  const now = new Date();
  const fixed = new Date(now.getTime() - 3600 * 1000);
  const r = scoreArticle(
    mkArticle({
      link: "https://vercel.com/blog/some-post",
      canonicalUrl: "https://vercel.com/blog/some-post",
      source: "Vercel Blog",
      sourcePriority: 2,
      pubDate: fixed,
    }),
    now,
  );
  assert.equal(r.pathPenalty, 0);
});

test("score: bất kỳ */release-notes/* bị path penalty", () => {
  const now = new Date();
  const fixed = new Date(now.getTime() - 3600 * 1000);
  const r = scoreArticle(
    mkArticle({
      link: "https://github.com/foo/release-notes/v2.0",
      canonicalUrl: "https://github.com/foo/release-notes/v2.0",
      pubDate: fixed,
    }),
    now,
  );
  assert.ok(r.pathPenalty > 0);
});

test("score: path 'release-notes' chỉ match khi là segment, không phải substring", () => {
  const now = new Date();
  const fixed = new Date(now.getTime() - 3600 * 1000);
  // Path "/announce-release-notes-feature" KHÔNG nên match
  const r = scoreArticle(
    mkArticle({
      link: "https://example.com/announce-release-notes-feature",
      canonicalUrl: "https://example.com/announce-release-notes-feature",
      pubDate: fixed,
    }),
    now,
  );
  assert.equal(r.pathPenalty, 0, "substring 'release-notes' trong segment tên khác KHÔNG match");
});

// Phase 17: QA editorial scenarios — verify 3 bài bị flag không còn lọt top
test("score QA: 'GitHub for Beginners: Markdown' bị fluff penalty kéo xuống", () => {
  const now = new Date();
  const fixed = new Date(now.getTime() - 3600 * 1000);
  const tutorial = scoreArticle(
    mkArticle({
      title: "GitHub for Beginners: Markdown",
      link: "https://github.blog/2026/04/29/github-for-beginners-markdown",
      canonicalUrl: "https://github.blog/2026/04/29/github-for-beginners-markdown",
      source: "GitHub Blog",
      sourcePriority: 2,
      pubDate: fixed,
    }),
    now,
  );
  const realNews = scoreArticle(
    mkArticle({
      title: "GitHub launches new Copilot extension",
      link: "https://github.blog/2026/04/29/copilot-launch",
      canonicalUrl: "https://github.blog/2026/04/29/copilot-launch",
      source: "GitHub Blog",
      sourcePriority: 2,
      pubDate: fixed,
    }),
    now,
  );
  assert.ok(tutorial.fluffPenalty > 0);
  assert.ok(
    realNews.total > tutorial.total,
    `real news (${realNews.total}) phải xếp trên tutorial (${tutorial.total})`,
  );
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
  // trend đã đầy 4/4 (Phase 19.6 quota) → phải chọn core1
  const usage = { core: 0, ai: 0, dev: 0, research: 0, trend: 4 };
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
  // Quota mặc định Phase 19.6: core=8 → cần usage=8 để full
  const s = formatUsage({ core: 8, ai: 1, dev: 0, research: 0, trend: 0 });
  assert.match(s, /core 8\/8\(full\)/);
  assert.match(s, /ai 1\/7/);
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
// Phase 19.7: bilingual hybrid — EN TL;DR + hashtags (caption + parser)
// ────────────────────────────────────────────────────────────────────────────

test("telegram.formatCaption Phase 19.7: render EN section + hashtag line", () => {
  const article = mkArticle({ link: "https://example.com/post" });
  const summary = {
    title: "🚀 GPT-5 ra mắt",
    bullets: ["Context 10M tokens", "Reasoning tốt hơn 30%"],
    whyItMatters: "Đặt chuẩn mới cho LLM.",
    enTldr: "OpenAI launches GPT-5 with 10M token context and 30% better reasoning.",
    hashtags: ["AI", "OpenAI", "GPT5"],
  };
  const env = { TELEGRAM_CHANNEL_ID: "@techbuzz_daily" } as any;
  const out = telegramTest.formatCaption(article, summary, env, 1024);
  // VN content vẫn đầy đủ
  assert.match(out, /<b>🚀 GPT-5 ra mắt<\/b>/);
  assert.match(out, /• Context 10M tokens/);
  assert.match(out, /Vì sao đáng đọc:/);
  // EN section
  assert.match(out, /━━━━━━━━━━/);
  assert.match(out, /🌐 <i>EN:<\/i> OpenAI launches GPT-5/);
  // Hashtag line — 3 từ AI + brand auto-append
  assert.match(out, /#AI #OpenAI #GPT5 #TechBuzzDaily/);
  // Order: title → bullets → why → enBlock → link → signature → hashtag
  const titlePos = out.indexOf("<b>🚀");
  const bulletsPos = out.indexOf("• Context");
  const whyPos = out.indexOf("Vì sao");
  const enPos = out.indexOf("🌐");
  const linkPos = out.indexOf("🔗");
  const sigPos = out.indexOf("Tech Buzz Daily</b>");
  const hashtagPos = out.indexOf("#AI");
  assert.ok(
    titlePos < bulletsPos && bulletsPos < whyPos && whyPos < enPos &&
      enPos < linkPos && linkPos < sigPos && sigPos < hashtagPos,
    "thứ tự sections sai",
  );
});

test("telegram.formatCaption Phase 19.7: backward compat — không có enTldr/hashtags → format cũ", () => {
  const article = mkArticle({ link: "https://example.com/p" });
  const summary = {
    title: "T",
    bullets: ["b1"],
    whyItMatters: "w",
    // enTldr + hashtags undefined → schema cũ
  };
  const env = { TELEGRAM_CHANNEL_ID: "@x" } as any;
  const out = telegramTest.formatCaption(article, summary, env, 1024);
  assert.ok(!out.includes("━━━"), "không được render separator khi không có EN");
  assert.ok(!out.includes("🌐"), "không được render EN line khi enTldr rỗng");
  assert.ok(!out.includes("#"), "không được render hashtag khi hashtags rỗng");
});

test("telegram.formatCaption Phase 19.7: enTldr rỗng nhưng hashtags có → vẫn render hashtag", () => {
  const article = mkArticle({ link: "https://example.com/p" });
  const summary = {
    title: "T",
    bullets: ["b1"],
    whyItMatters: "w",
    enTldr: "",
    hashtags: ["AI"],
  };
  const env = { TELEGRAM_CHANNEL_ID: "@x" } as any;
  const out = telegramTest.formatCaption(article, summary, env, 1024);
  assert.ok(!out.includes("🌐"));
  assert.match(out, /#AI #TechBuzzDaily/);
});

test("telegram.formatCaption Phase 19.7: caption tight → drop hashtag trước, giữ EN", () => {
  // Dùng env KHÔNG có @handle để signature ngắn (~27 chars), dễ tính toán.
  // Fixed parts: title 87 + why 175 + link 60 + sig 27 = 349
  // + EN block (~47), + hashtag line (~49)
  // maxLen=460 → drop hashtag (vượt 30 char budget cho bullets), giữ EN.
  const article = mkArticle({ link: "https://example.com/p" });
  const summary = {
    title: "T".repeat(80),
    bullets: ["bullet"],
    whyItMatters: "W".repeat(150),
    enTldr: "Short EN summary here.",
    hashtags: ["AI", "OpenAI", "GPT5", "MachineLearning"],
  };
  const env = { TELEGRAM_CHANNEL_ID: "" } as any; // signature không link handle
  const out = telegramTest.formatCaption(article, summary, env, 460);
  assert.ok(out.length <= 460, `caption ${out.length} vượt 460`);
  assert.ok(!out.includes("#AI"), `hashtag phải bị drop, got len=${out.length}: ${out}`);
  assert.match(out, /🌐 <i>EN:<\/i> Short EN summary/);
});

test("telegram.formatCaption Phase 19.7: caption rất tight → drop cả EN + hashtag", () => {
  // Dùng env KHÔNG có @handle. Cùng setup nhưng maxLen tight hơn.
  // Fixed parts: 349. + EN(47)+gap(2)=396 → cần budget bullets ≥30 → maxLen≥436.
  // maxLen=410 → kể cả không EN/hashtag, bullets budget = 410-349-8 = 53 ≥ 30 ✓
  // Nhưng +EN: 410-396-10 = 4 < 30 → drop EN.
  const article = mkArticle({ link: "https://example.com/p" });
  const summary = {
    title: "T".repeat(80),
    bullets: ["bullet"],
    whyItMatters: "W".repeat(150),
    enTldr: "EN summary text content here.",
    hashtags: ["AI", "OpenAI"],
  };
  const env = { TELEGRAM_CHANNEL_ID: "" } as any;
  const out = telegramTest.formatCaption(article, summary, env, 410);
  assert.ok(out.length <= 410, `caption ${out.length} vượt 410`);
  assert.ok(!out.includes("#AI"));
  assert.ok(!out.includes("🌐"));
  assert.ok(!out.includes("━━━"));
});

test("telegram.buildHashtagList: brand auto-append + dedupe case-insensitive", () => {
  // Case 1: AI không có brand → append
  assert.deepEqual(
    telegramTest.buildHashtagList(["AI", "OpenAI"]),
    ["AI", "OpenAI", "TechBuzzDaily"],
  );
  // Case 2: AI có brand sẵn (lowercase) → không double-append
  assert.deepEqual(
    telegramTest.buildHashtagList(["AI", "techbuzzdaily"]),
    ["AI", "techbuzzdaily"],
  );
  // Case 3: Quá nhiều hashtag → cap 5 (giữ chỗ brand = chỉ lấy 4 từ AI)
  assert.deepEqual(
    telegramTest.buildHashtagList(["a", "b", "c", "d", "e", "f", "g"]),
    ["a", "b", "c", "d", "TechBuzzDaily"],
  );
  // Case 4: Empty (backward compat schema cũ) → KHÔNG append brand đơn độc
  assert.deepEqual(telegramTest.buildHashtagList([]), []);
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

test("ai.tryParseSummary Phase 19.7: parse enTldr + hashtags từ schema mới", () => {
  const raw = JSON.stringify({
    title: "T",
    bullets: ["b1"],
    whyItMatters: "w",
    enTldr: "OpenAI launches GPT-5.",
    hashtags: ["AI", "OpenAI", "GPT5"],
  });
  const r = aiTest.tryParseSummary(raw);
  assert.ok(r);
  assert.equal(r!.enTldr, "OpenAI launches GPT-5.");
  assert.deepEqual(r!.hashtags, ["AI", "OpenAI", "GPT5"]);
});

test("ai.tryParseSummary Phase 19.7: backward compat — schema cũ không có enTldr/hashtags → fields rỗng", () => {
  const raw = JSON.stringify({
    title: "T",
    bullets: ["b1"],
    whyItMatters: "w",
  });
  const r = aiTest.tryParseSummary(raw);
  assert.ok(r);
  assert.equal(r!.enTldr, "");
  assert.deepEqual(r!.hashtags, []);
});

test("ai.sanitizeRawHashtags Phase 19.7: bỏ '#', bỏ space, reject non-ASCII + dedupe", () => {
  // Bỏ tiền tố #
  assert.deepEqual(aiTest.sanitizeRawHashtags(["#AI", "##OpenAI"]), ["AI", "OpenAI"]);
  // Bỏ space nội tại
  assert.deepEqual(aiTest.sanitizeRawHashtags(["Open AI", "Machine Learning"]), [
    "OpenAI",
    "MachineLearning",
  ]);
  // Reject non-ASCII (tiếng Việt có dấu, emoji)
  assert.deepEqual(aiTest.sanitizeRawHashtags(["CôngNghệ", "AI🚀", "OpenAI"]), ["OpenAI"]);
  // Reject ký tự đặc biệt (-, !, .)
  assert.deepEqual(aiTest.sanitizeRawHashtags(["AI-Lab", "GPT.5", "GPT5"]), ["GPT5"]);
  // Dedupe case-insensitive
  assert.deepEqual(aiTest.sanitizeRawHashtags(["AI", "ai", "Ai"]), ["AI"]);
  // Reject quá dài (>30 chars)
  assert.deepEqual(
    aiTest.sanitizeRawHashtags(["A".repeat(31), "OK"]),
    ["OK"],
  );
  // Cap 8 tag
  const many = Array.from({ length: 12 }, (_, i) => `tag${i}`);
  assert.equal(aiTest.sanitizeRawHashtags(many).length, 8);
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

test("ai.classifyHttpError: 408 → fatal (Phase 18: timeout = waste budget)", () => {
  assert.equal(aiTest.classifyHttpError(408).fatal, true);
});

test("ai.ProviderError: markDead flag default false, settable via constructor", () => {
  const e = new aiTest.ProviderError("test", 500, false);
  assert.equal(e.markDead, false);
  const e2 = new aiTest.ProviderError("test", 500, false, true);
  assert.equal(e2.markDead, true);
  assert.equal(e2.fatal, false);
});

test("ai.ProviderError: markDead có thể set sau khi tạo (Phase 18 5xx lặp)", () => {
  const e = new aiTest.ProviderError("test", 503, false);
  assert.equal(e.markDead, false);
  e.markDead = true;
  assert.equal(e.markDead, true);
});

// ────────────────────────────────────────────────────────────────────────────
// Phase 16: probeProviders (powers /diag_ai endpoint)
// ────────────────────────────────────────────────────────────────────────────

import {
  probeProviders,
  probeKvRoundTrip,
  runKvOps,
  summarizeKvResults,
  type DiagProviderResult,
  type KvLike,
  type KvOpResult,
} from "../src/diag.ts";

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

// ────────────────────────────────────────────────────────────────────────────
// Phase 17: runKvOps + summarizeKvResults (powers post-Telegram book-keeping)
// ────────────────────────────────────────────────────────────────────────────

test("runKvOps: all success → all ok=true with ms ≥ 0", async () => {
  const results = await runKvOps([
    { name: "a", op: async () => undefined },
    { name: "b", op: async () => undefined },
  ]);
  assert.equal(results.length, 2);
  assert.equal(results[0].name, "a");
  assert.equal(results[0].ok, true);
  assert.equal(results[0].error, undefined);
  assert.ok(results[0].ms >= 0);
  assert.equal(results[1].ok, true);
});

test("runKvOps: 1 op throw → that op ok=false, others vẫn chạy", async () => {
  const results = await runKvOps([
    { name: "good", op: async () => undefined },
    { name: "bad", op: async () => { throw new Error("KV write failed: 503"); } },
    { name: "alsoGood", op: async () => undefined },
  ]);
  assert.equal(results.length, 3);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.match(results[1].error ?? "", /503/);
  assert.equal(results[2].ok, true, "subsequent ops phải tiếp tục dù 1 cái fail");
});

test("runKvOps: error message truncated to 200 chars", async () => {
  const longMsg = "x".repeat(500);
  const results = await runKvOps([
    { name: "verbose", op: async () => { throw new Error(longMsg); } },
  ]);
  assert.equal(results[0].ok, false);
  assert.equal(results[0].error?.length, 200);
});

test("runKvOps: empty list → empty result (no crash)", async () => {
  const results = await runKvOps([]);
  assert.deepEqual(results, []);
});

test("summarizeKvResults: all OK → failCount=0, no failDetail", () => {
  const results: KvOpResult[] = [
    { name: "a", ok: true, ms: 12 },
    { name: "b", ok: true, ms: 8 },
  ];
  const sum = summarizeKvResults(results);
  assert.equal(sum.okCount, 2);
  assert.equal(sum.failCount, 0);
  assert.equal(sum.failDetail, undefined);
  assert.match(sum.statusLine, /2\/2 OK/);
  assert.match(sum.statusLine, /a=ok\(12ms\)/);
  assert.match(sum.statusLine, /b=ok\(8ms\)/);
});

test("summarizeKvResults: mixed → failCount accurate, failDetail liệt kê tên+error", () => {
  const results: KvOpResult[] = [
    { name: "markTitlePosted", ok: true, ms: 20 },
    { name: "setLastPosted", ok: false, ms: 5000, error: "KV timeout" },
    { name: "pushRecentTitle", ok: false, ms: 12, error: "rate limited" },
  ];
  const sum = summarizeKvResults(results);
  assert.equal(sum.okCount, 1);
  assert.equal(sum.failCount, 2);
  assert.match(sum.statusLine, /1\/3 OK/);
  assert.match(sum.statusLine, /markTitlePosted=ok/);
  assert.match(sum.statusLine, /setLastPosted=FAIL/);
  assert.match(sum.failDetail ?? "", /setLastPosted: KV timeout/);
  assert.match(sum.failDetail ?? "", /pushRecentTitle: rate limited/);
});

test("summarizeKvResults: empty list → 0/0 OK, no failDetail", () => {
  const sum = summarizeKvResults([]);
  assert.equal(sum.okCount, 0);
  assert.equal(sum.failCount, 0);
  assert.equal(sum.failDetail, undefined);
  assert.match(sum.statusLine, /0\/0 OK/);
});

// ────────────────────────────────────────────────────────────────────────────
// Phase 17: probeKvRoundTrip (powers /debug_kv endpoint)
// ────────────────────────────────────────────────────────────────────────────

/** Minimal in-memory KV fake để test probeKvRoundTrip. */
function makeFakeKv(overrides: Partial<KvLike> = {}): KvLike {
  const store = new Map<string, string>();
  return {
    put: async (k, v) => { store.set(k, v); },
    get: async (k) => store.get(k) ?? null,
    delete: async (k) => { store.delete(k); },
    ...overrides,
  };
}

test("probeKvRoundTrip: happy path → 3 ops all ok, get matched=true", async () => {
  const kv = makeFakeKv();
  const ops = await probeKvRoundTrip(kv, "test-key", "test-val");
  assert.equal(ops.length, 3);
  assert.equal(ops[0].op, "put");
  assert.equal(ops[0].ok, true);
  assert.equal(ops[1].op, "get");
  assert.equal(ops[1].ok, true);
  assert.equal(ops[1].matched, true);
  assert.equal(ops[2].op, "delete");
  assert.equal(ops[2].ok, true);
});

test("probeKvRoundTrip: PUT fail → short-circuit, không thử get/delete", async () => {
  const kv = makeFakeKv({
    put: async () => { throw new Error("namespace not bound"); },
  });
  const ops = await probeKvRoundTrip(kv, "k", "v");
  assert.equal(ops.length, 1, "PUT fail phải short-circuit");
  assert.equal(ops[0].op, "put");
  assert.equal(ops[0].ok, false);
  assert.match(ops[0].error ?? "", /namespace not bound/);
});

test("probeKvRoundTrip: GET trả null (eventual consistency) → put.ok=true, get.matched=false", async () => {
  const kv = makeFakeKv({
    put: async () => undefined, // accept write nhưng không lưu
    get: async () => null,
  });
  const ops = await probeKvRoundTrip(kv, "k", "v");
  assert.equal(ops.length, 3);
  assert.equal(ops[0].ok, true, "PUT vẫn báo ok dù backend không actually persist");
  assert.equal(ops[1].ok, true, "GET không throw → ok=true");
  assert.equal(ops[1].matched, false, "Read-back không khớp → matched=false");
});

test("probeKvRoundTrip: GET throw → put OK, get fail, delete vẫn chạy", async () => {
  const kv = makeFakeKv({
    get: async () => { throw new Error("read timeout"); },
  });
  const ops = await probeKvRoundTrip(kv, "k", "v");
  assert.equal(ops.length, 3);
  assert.equal(ops[0].ok, true);
  assert.equal(ops[1].ok, false);
  assert.match(ops[1].error ?? "", /read timeout/);
  assert.equal(ops[2].ok, true);
});

test("probeKvRoundTrip: error message truncated to 200 chars", async () => {
  const longMsg = "y".repeat(600);
  const kv = makeFakeKv({
    put: async () => { throw new Error(longMsg); },
  });
  const ops = await probeKvRoundTrip(kv, "k", "v");
  assert.equal(ops[0].error?.length, 200);
});

// ────────────────────────────────────────────────────────────────────────────
// Task 6: skipped-slot counter + sendAdminAlert no-op
// ────────────────────────────────────────────────────────────────────────────

import {
  incrementSkippedSlotCount,
  getSkippedSlotCount,
  wasAdminAlertSent,
  markAdminAlertSent,
  type SkipCounterKv,
} from "../src/skipCounter.ts";

test("incrementSkippedSlotCount: count tăng đúng + ghi key skipped:<dayKey>", async () => {
  const store = new Map<string, string>();
  let lastTtl: number | undefined;
  const kv: SkipCounterKv = {
    put: async (k, v, opts) => { store.set(k, v); lastTtl = opts?.expirationTtl; },
    get: async (k) => store.get(k) ?? null,
  };
  const day = "2026-04-29";

  assert.equal(await getSkippedSlotCount(kv, day), 0, "ngày chưa có entry → 0");

  assert.equal(await incrementSkippedSlotCount(kv, day), 1);
  assert.equal(await incrementSkippedSlotCount(kv, day), 2);
  assert.equal(await incrementSkippedSlotCount(kv, day), 3);

  assert.equal(await getSkippedSlotCount(kv, day), 3);
  assert.equal(store.get("skipped:2026-04-29"), "3");
  // TTL phải được set (~36h) để counter auto-reset mỗi ngày, KHÔNG vĩnh viễn.
  assert.ok(lastTtl && lastTtl >= 24 * 3600 && lastTtl <= 48 * 3600,
    `TTL phải nằm trong [24h, 48h], thực tế = ${lastTtl}`);
});

test("incrementSkippedSlotCount: counter mỗi ngày độc lập", async () => {
  const store = new Map<string, string>();
  const kv: SkipCounterKv = {
    put: async (k, v) => { store.set(k, v); },
    get: async (k) => store.get(k) ?? null,
  };
  await incrementSkippedSlotCount(kv, "2026-04-29");
  await incrementSkippedSlotCount(kv, "2026-04-29");
  await incrementSkippedSlotCount(kv, "2026-04-30");
  assert.equal(await getSkippedSlotCount(kv, "2026-04-29"), 2);
  assert.equal(await getSkippedSlotCount(kv, "2026-04-30"), 1);
});

test("getSkippedSlotCount: corrupt value (NaN) → trả 0 an toàn", async () => {
  const store = new Map<string, string>([["skipped:2026-04-29", "abc"]]);
  const kv: SkipCounterKv = {
    put: async (k, v) => { store.set(k, v); },
    get: async (k) => store.get(k) ?? null,
  };
  assert.equal(await getSkippedSlotCount(kv, "2026-04-29"), 0);
});

test("getSkippedSlotCount: empty / missing → 0", async () => {
  const kv: SkipCounterKv = {
    put: async () => undefined,
    get: async () => null,
  };
  assert.equal(await getSkippedSlotCount(kv, "2026-05-01"), 0);
});

// ────────────────────────────────────────────────────────────────────────────
// Task 7: dynamic threshold (computeDynamicThreshold + percentileOf)
// ────────────────────────────────────────────────────────────────────────────

import {
  computeDynamicThreshold,
  percentileOf,
  FALLBACK_THRESHOLD,
  MIN_CLAMP as THRESHOLD_MIN_CLAMP,
  MAX_CLAMP as THRESHOLD_MAX_CLAMP,
  DEFAULT_PERCENTILE,
  MIN_HISTORY_FOR_DYNAMIC,
} from "../src/threshold.ts";

test("percentileOf: empty array → 0", () => {
  assert.equal(percentileOf([], 0.5), 0);
});

test("percentileOf: single value → trả luôn value đó với mọi p", () => {
  assert.equal(percentileOf([42], 0), 42);
  assert.equal(percentileOf([42], 0.5), 42);
  assert.equal(percentileOf([42], 1), 42);
});

test("percentileOf: R-7 linear interpolation (Excel PERCENTILE.INC)", () => {
  // [10, 20, 30, 40, 50] — n=5, n-1=4
  const v = [10, 20, 30, 40, 50];
  // p=0 → idx=0 → 10
  assert.equal(percentileOf(v, 0), 10);
  // p=1 → idx=4 → 50
  assert.equal(percentileOf(v, 1), 50);
  // p=0.5 → idx=2 → 30 (median)
  assert.equal(percentileOf(v, 0.5), 30);
  // p=0.25 → idx=1 → 20
  assert.equal(percentileOf(v, 0.25), 20);
  // p=0.4 → idx=1.6 → 20 + 0.6*(30-20) = 26
  assert.equal(percentileOf(v, 0.4), 26);
});

test("percentileOf: unsorted input → tự sort, không phụ thuộc thứ tự caller", () => {
  const a = percentileOf([50, 10, 30, 20, 40], 0.4);
  const b = percentileOf([10, 20, 30, 40, 50], 0.4);
  assert.equal(a, b);
});

test("percentileOf: clamp p về [0,1] — caller pass nhầm 40 không crash", () => {
  // p=40 (out-of-range) clamp về 1 → trả max
  assert.equal(percentileOf([10, 20, 30], 40), 30);
  // p=-1 clamp về 0 → trả min
  assert.equal(percentileOf([10, 20, 30], -1), 10);
});

test("percentileOf: skip NaN/Inf trong input", () => {
  // [10, NaN, 20, Inf, 30] → [10, 20, 30] sau filter → median = 20
  assert.equal(percentileOf([10, NaN, 20, Infinity, 30], 0.5), 20);
});

test("percentileOf: tất cả input đều NaN → 0", () => {
  assert.equal(percentileOf([NaN, Infinity, -Infinity], 0.5), 0);
});

test("computeDynamicThreshold: history < MIN_HISTORY_FOR_DYNAMIC → fallback (Phase 19.5: 195)", () => {
  // 0 entry → fallback
  assert.equal(computeDynamicThreshold([]), FALLBACK_THRESHOLD);
  // 9 entry (vẫn dưới MIN=10) → fallback dù phân phối nói khác
  const sparse = Array.from({ length: 9 }, (_, i) => ({ score: 100 + i }));
  assert.equal(computeDynamicThreshold(sparse), FALLBACK_THRESHOLD);
  assert.ok(MIN_HISTORY_FOR_DYNAMIC === 10, "MIN_HISTORY_FOR_DYNAMIC kỳ vọng = 10 (Phase 19.5)");
  assert.ok(FALLBACK_THRESHOLD === 195, "FALLBACK_THRESHOLD kỳ vọng = 195 (Phase 19.5)");
});

test("computeDynamicThreshold: history ≥ MIN → tính p25, clamp về [170, 260]", () => {
  // 25 entry phân phối đều 200..248 → p25 nằm trong clamp range
  const hist = Array.from({ length: 25 }, (_, i) => ({ score: 200 + i * 2 })); // 200..248
  const t = computeDynamicThreshold(hist);
  assert.ok(t >= THRESHOLD_MIN_CLAMP && t <= THRESHOLD_MAX_CLAMP,
    `threshold ${t} phải nằm trong clamp [${THRESHOLD_MIN_CLAMP}, ${THRESHOLD_MAX_CLAMP}]`);
  // sanity: với input 200..248, p25 = sorted[0.25*24] = sorted[6] = 212
  assert.equal(t, 212);
});

test("computeDynamicThreshold: clamp dưới khi percentile quá thấp", () => {
  // 30 entry toàn score < 170 → percentile sẽ < 170 → clamp lên 170
  const lowHist = Array.from({ length: 30 }, (_, i) => ({ score: 50 + i })); // 50..79
  const t = computeDynamicThreshold(lowHist);
  assert.equal(t, THRESHOLD_MIN_CLAMP, `clamp dưới phải kéo lên ${THRESHOLD_MIN_CLAMP}`);
});

test("computeDynamicThreshold: clamp trên khi percentile quá cao", () => {
  // 30 entry toàn score > 260 → percentile sẽ > 260 → clamp xuống 260
  const highHist = Array.from({ length: 30 }, (_, i) => ({ score: 300 + i })); // 300..329
  const t = computeDynamicThreshold(highHist);
  assert.equal(t, THRESHOLD_MAX_CLAMP, `clamp trên phải kéo xuống ${THRESHOLD_MAX_CLAMP}`);
});

test("computeDynamicThreshold: percentile arg overrides default", () => {
  // 25 entry 200..248 → p20 ≈ 200 + 0.2*48 = 209.6 → round 210
  const hist = Array.from({ length: 25 }, (_, i) => ({ score: 200 + i * 2 }));
  const tDefault = computeDynamicThreshold(hist); // p40
  const tP20 = computeDynamicThreshold(hist, 0.2);
  assert.ok(tP20 < tDefault, `p20 (${tP20}) phải < p40 (${tDefault})`);
});

test("computeDynamicThreshold: default param dùng đúng DEFAULT_PERCENTILE", () => {
  const hist = Array.from({ length: 50 }, (_, i) => ({ score: 200 + i * 2 }));
  const tDefault = computeDynamicThreshold(hist);
  const tExplicit = computeDynamicThreshold(hist, DEFAULT_PERCENTILE);
  assert.equal(tDefault, tExplicit);
});

test("computeDynamicThreshold: output luôn integer (round)", () => {
  // 21 entry → p40 ≈ giá trị lẻ → cần round
  const hist = Array.from({ length: 21 }, (_, i) => ({ score: 200 + i })); // 200..220
  const t = computeDynamicThreshold(hist);
  assert.equal(t, Math.round(t), "threshold phải là integer");
});

test("computeDynamicThreshold: output stable không phụ thuộc thứ tự history", () => {
  const sorted = Array.from({ length: 30 }, (_, i) => ({ score: 200 + i }));
  const reversed = [...sorted].reverse();
  const shuffled = [...sorted].sort(() => 0.5 - Math.random());
  assert.equal(computeDynamicThreshold(sorted), computeDynamicThreshold(reversed));
  assert.equal(computeDynamicThreshold(sorted), computeDynamicThreshold(shuffled));
});

test("computeDynamicThreshold: history exactly = MIN_HISTORY_FOR_DYNAMIC → dynamic mode (boundary)", () => {
  // Kỳ vọng ranh giới `< MIN` (không `≤`): 10 entry phải KÍCH HOẠT dynamic.
  const hist = Array.from({ length: MIN_HISTORY_FOR_DYNAMIC }, (_, i) => ({ score: 240 + i }));
  const t = computeDynamicThreshold(hist);
  // Với 240..249 (10 entry), p25 = sorted[0.25*9] = sorted[2.25]
  //   = 242 * 0.75 + 243 * 0.25 = 242.25 → round 242 → trong clamp
  // → KHÔNG phải fallback 195
  assert.notEqual(t, FALLBACK_THRESHOLD, "boundary: 10 entry kích hoạt dynamic mode");
  assert.equal(t, 242);
});

// Note: pushScoreHistory / getScoreHistory ở storage.ts KHÔNG có unit-test
// trực tiếp — cùng lý do với các helper KV khác trong storage.ts (xem comment
// trong skipCounter.ts): import storage.ts kéo theo url.js + dedup.js cần
// transpile thành .ts → strip-types loader của Node không tự rewrite .js→.ts.
// Hợp đồng `pushScoreHistory`/`getScoreHistory` mirror đúng `pushRecentTitle`/
// `getRecentTitles` (đã production-tested), test percentile + clamp ở trên đã
// cover phần phức tạp duy nhất.

test("wasAdminAlertSent / markAdminAlertSent: flag flow + TTL + day-isolation", async () => {
  const store = new Map<string, string>();
  let lastTtl: number | undefined;
  const kv: SkipCounterKv = {
    put: async (k, v, opts) => { store.set(k, v); lastTtl = opts?.expirationTtl; },
    get: async (k) => store.get(k) ?? null,
  };
  // Default state — chưa gửi → false
  assert.equal(await wasAdminAlertSent(kv, "2026-04-29"), false);

  // Sau khi mark → true
  await markAdminAlertSent(kv, "2026-04-29");
  assert.equal(await wasAdminAlertSent(kv, "2026-04-29"), true);
  assert.ok(lastTtl && lastTtl >= 24 * 3600 && lastTtl <= 48 * 3600,
    `TTL flag phải nằm trong [24h, 48h], thực tế = ${lastTtl}`);

  // Ngày khác vẫn false (KHÔNG share flag giữa các ngày)
  assert.equal(await wasAdminAlertSent(kv, "2026-04-30"), false);

  // Counter key (skipped:) và flag key (skipped_alert_sent:) là 2 namespace
  // khác nhau → flag KHÔNG ăn vào counter và ngược lại.
  assert.equal(await getSkippedSlotCount(kv, "2026-04-29"), 0,
    "set flag KHÔNG được vô tình tăng counter");
});

// ────────────────────────────────────────────────────────────────────────────
// Phase 19.8: queue module (slot key, enqueue/dequeue, slot enumeration)
// ────────────────────────────────────────────────────────────────────────────

import {
  slotKeyForUTC,
  currentHourSlot,
  nextHourSlot,
  isPostHourUTC,
  enumerateNextPostSlots,
  articleToJson,
  articleFromJson,
  enqueueSlot,
  peekSlot,
  dequeueSlot,
  clearSlot,
  listQueue,
  type QueueEnv,
  type QueuePayload,
} from "../src/queue.ts";

function makeFakeKvForQueue() {
  const store = new Map<string, { value: string; ttl?: number }>();
  const kv = {
    get: async (k: string) => store.get(k)?.value ?? null,
    put: async (k: string, v: string, opts?: { expirationTtl?: number }) => {
      store.set(k, { value: v, ttl: opts?.expirationTtl });
    },
    delete: async (k: string) => {
      store.delete(k);
    },
    list: async (opts?: { prefix?: string }) => {
      const prefix = opts?.prefix ?? "";
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true, cursor: "" };
    },
  } as unknown as KVNamespace;
  return { store, env: { POSTED_KV: kv } as QueueEnv };
}

const fakeArticle = {
  title: "Sample tech post",
  link: "https://example.com/a",
  canonicalUrl: "https://example.com/a",
  pubDate: new Date("2026-04-30T05:00:00.000Z"),
  source: "Example",
  sourceCategory: "ai" as const,
  sourcePriority: "p1" as const,
  contentSnippet: "snippet here",
  imageUrl: "https://example.com/img.jpg",
  score: 220,
  titleHash: "deadbeef",
};

const fakeSummary = {
  title: "VN title here",
  body: "body line 1\nbody line 2",
  hashtag: "#AI",
};

test("slotKeyForUTC: format đúng `queue:YYYY-MM-DDTHH` với pad-zero", () => {
  assert.equal(
    slotKeyForUTC(new Date("2026-04-30T07:00:00.000Z")),
    "queue:2026-04-30T07",
  );
  assert.equal(
    slotKeyForUTC(new Date("2026-12-01T00:30:45.000Z")),
    "queue:2026-12-01T00",
  );
  assert.equal(
    slotKeyForUTC(new Date("2026-01-09T17:59:59.999Z")),
    "queue:2026-01-09T17",
  );
});

test("currentHourSlot: align về :00 cùng giờ UTC", () => {
  const out = currentHourSlot(new Date("2026-04-30T14:37:22.123Z"));
  assert.equal(out.toISOString(), "2026-04-30T14:00:00.000Z");
});

test("nextHourSlot: tăng 1 giờ + align :00 (kể cả khi minute=0)", () => {
  assert.equal(
    nextHourSlot(new Date("2026-04-30T14:00:00.000Z")).toISOString(),
    "2026-04-30T15:00:00.000Z",
  );
  assert.equal(
    nextHourSlot(new Date("2026-04-30T14:37:22.123Z")).toISOString(),
    "2026-04-30T15:00:00.000Z",
  );
  // Wrap qua ngày
  assert.equal(
    nextHourSlot(new Date("2026-04-30T23:30:00.000Z")).toISOString(),
    "2026-05-01T00:00:00.000Z",
  );
});

test("isPostHourUTC: chỉ 0..17 là post hour (Phase 19.6 cron)", () => {
  for (let h = 0; h <= 17; h++) assert.equal(isPostHourUTC(h), true, `${h} phải là post hour`);
  for (let h = 18; h <= 23; h++) assert.equal(isPostHourUTC(h), false, `${h} KHÔNG phải post hour`);
});

test("enumerateNextPostSlots: refill từ giữa khung post → 18 slot trải 2 ngày", () => {
  const slots = enumerateNextPostSlots(new Date("2026-04-30T06:30:00.000Z"), 18);
  assert.equal(slots.length, 18);
  // Slot đầu = 07:00 UTC cùng ngày
  assert.equal(slots[0].toISOString(), "2026-04-30T07:00:00.000Z");
  // Slot thứ 11 (idx 10) = 17:00 UTC cùng ngày (last today)
  assert.equal(slots[10].toISOString(), "2026-04-30T17:00:00.000Z");
  // Slot 12 (idx 11) phải SKIP qua đêm về 00:00 UTC ngày mai
  assert.equal(slots[11].toISOString(), "2026-05-01T00:00:00.000Z");
  // Slot cuối = 06:00 UTC ngày mai
  assert.equal(slots[17].toISOString(), "2026-05-01T06:00:00.000Z");
  // Tất cả slot phải là post hour
  for (const s of slots) {
    assert.equal(isPostHourUTC(s.getUTCHours()), true);
  }
});

test("enumerateNextPostSlots: từ 17:30 UTC → slot đầu phải skip 18-23 → 00:00 ngày mai", () => {
  const slots = enumerateNextPostSlots(new Date("2026-04-30T17:30:00.000Z"), 3);
  assert.equal(slots[0].toISOString(), "2026-05-01T00:00:00.000Z");
  assert.equal(slots[1].toISOString(), "2026-05-01T01:00:00.000Z");
  assert.equal(slots[2].toISOString(), "2026-05-01T02:00:00.000Z");
});

test("articleToJson + articleFromJson: round-trip bảo toàn data, Date↔ISO", () => {
  const j = articleToJson(fakeArticle);
  assert.equal(typeof j.pubDate, "string");
  assert.equal(j.pubDate, "2026-04-30T05:00:00.000Z");
  const back = articleFromJson(j);
  assert.equal(back.title, fakeArticle.title);
  assert.equal(back.link, fakeArticle.link);
  assert.equal(back.canonicalUrl, fakeArticle.canonicalUrl);
  assert.equal(back.pubDate.toISOString(), fakeArticle.pubDate.toISOString());
  assert.equal(back.source, fakeArticle.source);
  assert.equal(back.sourceCategory, fakeArticle.sourceCategory);
  assert.equal(back.sourcePriority, fakeArticle.sourcePriority);
  assert.equal(back.contentSnippet, fakeArticle.contentSnippet);
  assert.equal(back.imageUrl, fakeArticle.imageUrl);
  assert.equal(back.score, fakeArticle.score);
  assert.equal(back.titleHash, fakeArticle.titleHash);
});

test("articleToJson: imageUrl undefined giữ nguyên undefined (không leak rác)", () => {
  const j = articleToJson({ ...fakeArticle, imageUrl: undefined });
  assert.equal(j.imageUrl, undefined);
  const back = articleFromJson(j);
  assert.equal(back.imageUrl, undefined);
});

test("enqueueSlot + peekSlot + dequeueSlot: happy path round-trip", async () => {
  const { store, env } = makeFakeKvForQueue();
  const slot = new Date("2026-04-30T08:00:00.000Z");
  const payload: QueuePayload = {
    article: articleToJson(fakeArticle),
    summary: fakeSummary,
    generatedAt: "2026-04-30T06:30:01.000Z",
    scheduledFor: slot.toISOString(),
    aiProvider: "gemini-2.5-k0",
  };

  await enqueueSlot(env, slot, payload);

  // TTL phải set ~36h
  const entry = store.get("queue:2026-04-30T08");
  assert.ok(entry, "key phải tồn tại");
  assert.ok(
    entry!.ttl && entry!.ttl >= 24 * 3600 && entry!.ttl <= 48 * 3600,
    `TTL phải [24h, 48h], thực tế = ${entry!.ttl}`,
  );

  // peek không xóa
  const peeked = await peekSlot(env, slot);
  assert.deepEqual(peeked, payload);
  assert.ok(store.has("queue:2026-04-30T08"), "peek không được xóa");

  // dequeue trả payload + xóa
  const got = await dequeueSlot(env, slot);
  assert.deepEqual(got, payload);
  assert.equal(store.has("queue:2026-04-30T08"), false, "dequeue phải xóa key");

  // dequeue lần 2 → null
  assert.equal(await dequeueSlot(env, slot), null);
});

test("dequeueSlot: corrupted JSON → return null + xóa key (clean rác)", async () => {
  const { store, env } = makeFakeKvForQueue();
  store.set("queue:2026-04-30T09", { value: "not valid json {{{" });
  const slot = new Date("2026-04-30T09:00:00.000Z");
  const got = await dequeueSlot(env, slot);
  assert.equal(got, null);
  assert.equal(store.has("queue:2026-04-30T09"), false, "key corrupted phải bị xóa");
});

test("peekSlot: corrupted JSON → null nhưng KHÔNG xóa (caller dequeue mới xóa)", async () => {
  const { store, env } = makeFakeKvForQueue();
  store.set("queue:2026-04-30T09", { value: "{bad}" });
  const slot = new Date("2026-04-30T09:00:00.000Z");
  assert.equal(await peekSlot(env, slot), null);
  assert.equal(store.has("queue:2026-04-30T09"), true, "peek không được xóa rác");
});

test("clearSlot: xóa slot bất kể có hay không", async () => {
  const { store, env } = makeFakeKvForQueue();
  const slot = new Date("2026-04-30T10:00:00.000Z");
  await enqueueSlot(env, slot, {
    article: articleToJson(fakeArticle),
    summary: fakeSummary,
    generatedAt: new Date().toISOString(),
    scheduledFor: slot.toISOString(),
    aiProvider: "test",
  });
  assert.ok(store.has("queue:2026-04-30T10"));
  await clearSlot(env, slot);
  assert.equal(store.has("queue:2026-04-30T10"), false);
  // Idempotent: clear lại không throw
  await clearSlot(env, slot);
});

test("listQueue: trả entry sort theo slot key tăng dần, skip corrupted", async () => {
  const { store, env } = makeFakeKvForQueue();
  const mkPayload = (h: number): QueuePayload => ({
    article: articleToJson(fakeArticle),
    summary: { ...fakeSummary, title: `t${h}` },
    generatedAt: new Date().toISOString(),
    scheduledFor: `2026-04-30T${String(h).padStart(2, "0")}:00:00.000Z`,
    aiProvider: "p",
  });
  await enqueueSlot(env, new Date("2026-04-30T15:00:00Z"), mkPayload(15));
  await enqueueSlot(env, new Date("2026-04-30T07:00:00Z"), mkPayload(7));
  await enqueueSlot(env, new Date("2026-04-30T10:00:00Z"), mkPayload(10));
  // Inject 1 entry corrupted
  store.set("queue:2026-04-30T11", { value: "{bad}" });
  // Inject 1 entry không phải prefix queue: → list không được trả
  store.set("posted:abc123", { value: "1" });

  const entries = await listQueue(env);
  assert.equal(entries.length, 3, "corrupted skip + non-queue: prefix không match");
  assert.deepEqual(
    entries.map((e) => e.slot),
    ["queue:2026-04-30T07", "queue:2026-04-30T10", "queue:2026-04-30T15"],
    "phải sort tăng dần theo slot key",
  );
  assert.equal(entries[0].payload.summary.title, "t7");
});

test("enqueueSlot: re-enqueue cùng slot → ghi đè (idempotent refill rerun)", async () => {
  const { store, env } = makeFakeKvForQueue();
  const slot = new Date("2026-04-30T12:00:00.000Z");
  const p1: QueuePayload = {
    article: articleToJson(fakeArticle),
    summary: { ...fakeSummary, title: "old" },
    generatedAt: "2026-04-30T06:00:00.000Z",
    scheduledFor: slot.toISOString(),
    aiProvider: "v1",
  };
  const p2: QueuePayload = { ...p1, summary: { ...fakeSummary, title: "new" }, aiProvider: "v2" };
  await enqueueSlot(env, slot, p1);
  await enqueueSlot(env, slot, p2);
  assert.equal(store.size, 1, "không tạo key thứ 2");
  const got = await peekSlot(env, slot);
  assert.equal(got!.summary.title, "new");
  assert.equal(got!.aiProvider, "v2");
});
