# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `pnpm --filter @workspace/scripts run post-news` — run Tech Buzz Daily bot once (DEPRECATED, see below)

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Tech Buzz Daily Bot

Telegram bot that fetches RSS tech news, summarizes with Gemini AI, and posts to `@techbuzz_daily` **mỗi giờ từ 7h sáng tới 0h đêm Việt Nam (18 bài/ngày)**.

### Cloudflare Workers (PRIMARY — `worker/`)

Deployed to Cloudflare Workers. Migrated từ GitHub Actions vì GH Actions cron drift 30–60 phút vào ban đêm. Cloudflare Cron triggers fire trong vài giây của UTC scheduled time.

- **Entry point**: `worker/src/index.ts` (exports `scheduled` + `fetch` handlers)
- **Modules**: `worker/src/{rss,ai,telegram,storage,sources,url,filter,score,dedup,bucket}.ts`
- **Tests**: `worker/test/run-tests.ts` — 77 unit tests (URL norm, HTML truncation, og:image, filter, score, dedup, bucket, telegram caption, ai parsing, AI key rotation, per-domain trust)
- **Config**: `worker/wrangler.toml` — cron `0 0-17 * * *` UTC (= mỗi giờ 7h-0h VN, 18 lần/ngày)
- **Storage**: Cloudflare KV namespace `POSTED_KV`
  - `posted:<sha1(canonical_url)>` — TTL 30 ngày, ngăn dupe URL
  - `title:<sha1(normalized_title)>` — TTL 30 ngày, ngăn dupe title từ URL khác
  - `recent_titles_v1` — list 200 title gần nhất cho fuzzy compare
  - `quota:YYYY-MM-DD:<category>` — đếm bài đã post mỗi bucket trong ngày
  - `last_posted_v1` — metadata bài cuối + run history (10 entry gần nhất)
  - `failed:<sha1(canonical_url)>` — fail counter, sau 3 lần fail liên tục → poison 24h
- **RSS sources**: **21 nguồn** curated (xem `worker/src/sources.ts`) — chia 5 category (`core`, `ai`, `dev`, `research`, `trend`) với priority 1-3. Phase 10: bỏ Anthropic News + Meta AI Blog (dead 404) + Papers with Code (parser fail), thêm Stripe / Cloudflare / Vercel / AWS / Simon Willison / Latent Space.
- **Endpoints debug** (`Authorization: Bearer <RUN_TRIGGER_TOKEN>`):
  - `GET /health`, `GET /sources`, `GET /stats`, `GET /last`
  - `GET /top_today` — top 10 candidate eligible + score breakdown chi tiết (Phase 13)
  - `POST /run` (alias `POST /force_fetch`) — manual trigger
  - `POST /run?dry=1` — dry run (chọn nhưng không post)
- **Phase 10/11/13/14 (Apr 2026)**:
  - Source health: 21/21 nguồn alive (trước: 14/18). FETCH_TIMEOUT 12s → 18s. MAX_AGE 48h → 30h.
  - Per-domain trust score (`score.ts`): `DOMAIN_TRUST_TABLE` (37 domain, +5..+25 boost) + `BLOCKED_DOMAINS` (19 domain SEO farm, penalty −1000). Suffix match (`news.openai.com` ≈ `openai.com`).
  - `NON_TECH_TITLE_KEYWORDS` mở rộng 11 → 32 từ (chính trị + showbiz + thể thao + lifestyle).
- **Pipeline (Phase 1-7 upgrade)**:
  1. Fetch song song 18 nguồn → strict filter cho arxiv (chỉ paper LLM/AI)
  2. Score article: `sourceWeight + recency + keyword(boost-penalty) + primaryLab + engineering + depth − hnPenalty`
  3. Cluster intra-batch (jaccard ≥ 0.80) — winner = source priority thấp hơn
  4. KV check exact (URL + title hash) → fuzzy check (jaccard ≥ 0.88 vs 200 title gần nhất)
  5. Bucket selection theo quota: `core 5 / ai 5 / dev 4 / research 2 / trend 2 = 18/ngày`; fallback highest score nếu mọi bucket đầy
  6. **AI summarize chain (Phase 9 + 9.2)**: `{ title, bullets[], whyItMatters }` — `getProviders(env)` build chain động dựa trên env, dừng ở cái đầu tiên thành công. Thứ tự:
     1. **Gemini 2.5 Flash** (1 provider/key) — quality cao nhất, ưu tiên
     2. **Gemini 2.0 Flash** (1 provider/key) — quota cao hơn, fallback khi 2.5 cạn
     3. **OpenRouter Llama 3.3 70B Instruct** (free model — chỉ chạy khi có `OPENROUTER_API_KEY`)
     4. **OpenRouter Gemma 3 27B IT** (free model — provider khác để né upstream rate-limit của Llama)

     **Key rotation (Phase 9.2)**: nếu set `GOOGLE_API_KEY_1.._5` (mỗi key 1 tài khoản Google = 1 quota free riêng), bot tạo provider riêng cho mỗi (model × key), tên thành `gemini-2.5-flash#k0`, `#k1`, ... Thứ tự: tất cả key cho 2.5-flash trước → tất cả key cho 2.0-flash → OpenRouter. Chỉ 1 key thì giữ tên cũ "gemini-2.5-flash" (backward compat).

     HTTP `429/401/403` từ provider → coi là fatal cho provider đó, fallback ngay sang provider kế (run-scoped circuit breaker `Set<string> deadProviders` skip ngay ở article kế tiếp). HTTP `5xx`/`408`/timeout → retry trong cùng provider (PARSE_RETRIES=2). Provider được dùng được log + ghi vào `last_posted_v1.provider`.
  7. Sau post: ghi posted/title/recent_titles/quota/last_posted (kèm `provider`)
- **Multi-candidate retry**: mỗi cron tick có sẵn full ranked list; nếu AI/Telegram fail bài đầu, tự thử bài tiếp theo
- **URL normalization**: dedupe dựa trên URL ĐÃ STRIP utm_*, fbclid, gclid, ref, fragment, sort params, lowercase host
- **Bundled với** `nodejs_compat`; RSS dùng `fast-xml-parser` + `fetch` (timeout 15s); Gemini gọi qua REST API (timeout 30s)

#### Required secrets (set qua `wrangler secret put`)

| Tên | Mô tả |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token từ @BotFather |
| `GOOGLE_API_KEY` | Gemini API key (provider 1+2 trong chain) |
| `OPENROUTER_API_KEY` | **Optional** — API key từ openrouter.ai/keys (provider 3+4: Llama/Gemma free). Không set → bot vẫn chạy chỉ với Gemini như cũ. |
| `RUN_TRIGGER_TOKEN` | Token RIÊNG để bảo vệ endpoint `/run` (KHÔNG dùng chung Telegram token) |

#### Required vars (in `wrangler.toml`)

`TELEGRAM_CHANNEL_ID`, `TELEGRAM_SIGNATURE`, `TELEGRAM_SIGNATURE_EMOJI`

#### HTTP endpoints

- `GET /health` — public ping (`200 ok`)
- `POST /run` — manual trigger ASYNC, **cần** `Authorization: Bearer <RUN_TRIGGER_TOKEN>`. Trả `202 Accepted`, chạy nền (xem log bằng `wrangler tail`).
- `POST /run?dry=1` — dry-run SYNC: chạy pipeline đầy đủ tới Gemini summarization NHƯNG không post Telegram. Trả JSON `{ runId, posted: false, attempted, postedTitle, ... }`. Hữu ích để verify format/quality.
- `GET /sources` — source health report, **cần Bearer**. Trả JSON liệt kê 18 nguồn + số bài fetched + ok/failed.
- `GET /stats` — quota usage hôm nay (mỗi bucket + total), **cần Bearer**.
- `GET /last` — bài cuối + 10 run gần nhất, **cần Bearer**.

Ví dụ trigger thủ công:
```bash
curl -X POST -H "Authorization: Bearer $RUN_TRIGGER_TOKEN" \
  https://techbuzz-bot.<account>.workers.dev/run
```

#### Commands

- `pnpm --filter techbuzz-worker run dev` — local dev với wrangler (cần secrets local)
- `pnpm --filter techbuzz-worker run deploy` — deploy lên Cloudflare
- `pnpm --filter techbuzz-worker run tail` — stream production logs
- `pnpm --filter techbuzz-worker run test` — chạy unit tests (URL norm + HTML truncation)
- `pnpm --filter techbuzz-worker run typecheck` — TypeScript check

> **Lưu ý**: package `techbuzz-worker` KHÔNG nằm trong `pnpm-workspace.yaml` (worker là project standalone trong `worker/`). Có thể chạy thẳng từ `worker/` bằng `npm run <script>` hoặc `npx wrangler ...`.

### GitHub Actions (LEGACY/BACKUP — `scripts/`)

Implementation Node.js gốc, **đã DEPRECATED** sau khi migrate sang Cloudflare. Cron đã tắt trong `.github/workflows/post-news.yml` (chỉ còn `workflow_dispatch` để chạy thủ công khi cần backup).

⚠️ **KHÔNG bật lại cron song song với Cloudflare Worker** — sẽ post trùng (dupe) vì 2 storage độc lập (`posted.json` vs Cloudflare KV).

- Entry point: `scripts/src/postNews.ts`
- Modules: `scripts/src/lib/{rss,ai,telegram,storage,sources,url}.ts`
- Posted history: `scripts/data/posted.json`
- 10 RSS sources (subset của worker)
- Deployment guide: `scripts/BOT_README.md`
