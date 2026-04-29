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

Telegram bot that fetches RSS tech news, summarizes with Gemini AI, and posts to `@techbuzz_daily` **mỗi 2 giờ từ 7h sáng tới 23h đêm Việt Nam (9 bài/ngày max — Phase 15)**. Slot có thể bị skip nếu không có bài score ≥ ngưỡng → ưu tiên CHẤT > LƯỢNG.

### Cloudflare Workers (PRIMARY — `worker/`)

Deployed to Cloudflare Workers. Migrated từ GitHub Actions vì GH Actions cron drift 30–60 phút vào ban đêm. Cloudflare Cron triggers fire trong vài giây của UTC scheduled time.

- **Entry point**: `worker/src/index.ts` (exports `scheduled` + `fetch` handlers)
- **Modules**: `worker/src/{rss,ai,telegram,storage,sources,url,filter,score,dedup,bucket}.ts`
- **Tests**: `worker/test/run-tests.ts` — 77 unit tests (URL norm, HTML truncation, og:image, filter, score, dedup, bucket, telegram caption, ai parsing, AI key rotation, per-domain trust)
- **Config**: `worker/wrangler.toml` — cron `0 0,2,4,6,8,10,12,14,16 * * *` UTC (= mỗi 2 giờ 7h-23h VN, **9 lần/ngày**, Phase 15)
- **Storage**: Cloudflare KV namespace `POSTED_KV`
  - `posted:<sha1(canonical_url)>` — TTL 30 ngày, ngăn dupe URL
  - `title:<sha1(normalized_title)>` — TTL 30 ngày, ngăn dupe title từ URL khác
  - `recent_titles_v1` — list 200 title gần nhất cho fuzzy compare
  - `quota:YYYY-MM-DD:<category>` — đếm bài đã post mỗi bucket trong ngày
  - `last_posted_v1` — metadata bài cuối + run history (10 entry gần nhất)
  - `failed:<sha1(canonical_url)>` — fail counter, sau 3 lần fail liên tục → poison 24h
  - `skipped:YYYY-MM-DD` — Task 6: counter slot/ngày bị skip do `all candidates below MIN_SCORE_THRESHOLD`. TTL 36h, auto-reset mỗi ngày. Cảnh báo Telegram cho admin khi ≥ 3 (xem `TELEGRAM_ADMIN_CHAT_ID`).
  - `skipped_alert_sent:YYYY-MM-DD` — Task 6: flag "đã gửi cảnh báo skipped-slot trong ngày X". TTL 36h. Bot chỉ set flag SAU khi gửi Telegram thành công → nếu Telegram down đúng tick count đạt 3, tick sau (count=4) sẽ retry, không miss alert. Khi flag tồn tại → silent (không spam admin).
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
- **Phase 15 (Apr 2026) — Quality > Quantity**:
  - **Cron 18→9 tick/ngày** (`wrangler.toml`): mỗi 2h thay vì mỗi giờ. Lý do: 18 bài/ngày bắt bot phải lấp slot bằng candidate score thấp, đồng thời ép Gemini free quota. Mỗi tick có nhiều "ngân sách AI" hơn → ít rủi ro fallback chain bị cạn cùng lúc.
  - **Min-score gate** (`index.ts`): `MIN_SCORE_THRESHOLD = 220`. Bài score < 220 bị skip; nếu cả batch dưới ngưỡng → slot bỏ trống (log reason `all candidates below MIN_SCORE_THRESHOLD`). KHÔNG fallback xuống bài rác.
  - **Quota mới** (`bucket.ts`): `core 6 / ai 5 / dev 4 / research 1 / trend 2 = 18` (cap, không phải target). Giảm `research` từ 2→1 để tránh arxiv niche dominate khi nguồn chính ít. Tăng `core` 5→6 bù lại. Vì cron chỉ 9 tick/ngày, cap 18 chỉ kick in khi 1 category có quá nhiều bài ngon.
  - **Key rotation hướng dẫn user**: nên tạo thêm 1 tài khoản Google + 1 Gemini API key (https://aistudio.google.com/apikey) → set vào CF Workers secret `GOOGLE_API_KEY_1` (Phase 9.2 đã support). Lệnh: `cd worker && wrangler secret put GOOGLE_API_KEY_1`. Có thể thêm `_2`, `_3` ... đến `_5` nếu cần. Mỗi key 1 quota free riêng → bot xoay vòng tự động.
  - **/top_today endpoint** trả thêm `minScoreThreshold` + `skippedLowScore` để diagnostic.
- **Phase 16 (Apr 29, 2026) — Diagnostic + Incident Apr 29**:
  - **Sự cố Apr 29:** KV trống cả ngày (0/18). Root cause = TOÀN BỘ 6 AI provider trong chain đều HTTP 429. Gemini (4 provider: 2 key × 2 model) "free_tier_requests, limit: 20" exceeded; OpenRouter (Llama + Gemma free) "temporarily rate-limited upstream". Bot không tóm tắt nổi 1 bài → KV trống. Hồi phục: chờ reset quota (00:00 Pacific) HOẶC nâng paid tier Gemini / mua key OpenRouter trả phí.
  - **Side bug phát hiện:** `MIN_SCORE_THRESHOLD = 220` quá cao — top scores hôm nay clustering quanh 218–248, chỉ ~3/137 bài qua threshold → ngay cả khi AI hồi phục, threshold vẫn chặn gần hết. Sẽ được xử lý ở task "Tự dò ngưỡng chất lượng".
  - **`runBot` ghi `lastAiError` vào `RunResult.reason`**: dry-run / `/run` giờ lộ message thực của provider cuối (không cần `wrangler tail`).
  - **`/top_today` thêm `topPreGate`**: top 10 bài có score cao nhất TRƯỚC khi qua MIN_SCORE_THRESHOLD + KV check → nhìn được score thực tế của batch hiện tại.
  - **Endpoint MỚI `/diag_ai`** (cần Bearer): probe từng AI provider trên 1 article giả, KHÔNG chạm KV/Telegram/RSS. Trả `{provider, ok, ms, error}` cho từng cái — chẩn đoán "provider nào sống/chết" trong 1 request.
- **Phase 18.5 (Apr 29, 2026) — Throughput + circuit breaker tuning**:
  - **Cron 9 → 24 tick/ngày** (`wrangler.toml`): từ `0 0,2,4,6,8,10,12,14,16 * * *` về `0 * * * *`. Lý do: Phase 15+16+17 đã thắt scoring/dedup/threshold rất chặt → bài rác đã bị lọc ngay ở filter/score, không cần ép cron thưa để "bù chất". 9 tick/ngày + skip-low-score → thực tế chỉ post 3-6 bài/ngày, ít hơn cadence kỳ vọng.
  - **MIN_SCORE_THRESHOLD 220 → 190** (`index.ts`). Lý do: dữ liệu Phase 16 cho thấy 220 quá cao — top scores clustering 218–248, chỉ ~3% bài qua → quá nhiều slot bỏ trống. 190 cho phép ~50% bài qua trong khi vẫn loại priority 3 + recency cũ + không boost.
  - **MAX_CANDIDATES_PER_RUN 5 → 3** (`index.ts`): với circuit breaker mạnh hơn, provider chậm chết sớm → ít cần buffer 5 candidate. 3 vẫn dư cho retry khi 1-2 bài fail Telegram/AI.
  - **AI timeout/retry mạnh hơn** (`worker/src/ai.ts`):
    - `GEMINI_TIMEOUT_MS 20s → 10s`, `GEMINI_MAX_RETRIES 3 → 2`. Worst case 1 provider 66s → 22s.
    - `PARSE_RETRIES_PER_PROVIDER 2 → 1` (LLM cùng prompt + temperature thường cho output tương tự, retry parse fail thường vô ích).
  - **Circuit breaker mạnh hơn** (`classifyHttpError` + `callGemini`/`callOpenRouter`):
    - **`408` (timeout) → fatal** (cũ: non-fatal). Slow provider chết ngay, không retry trong cùng candidate.
    - **Client-side AbortError → 408 fatal**: client timeout cũng coi như provider chết → throw immediately.
    - **5xx LẶP LẠI ≥2 lần trong cùng provider attempt flow → markDead**: thêm flag `markDead` trên `ProviderError`. Khi `callGemini`/`callOpenRouter` đếm `serverErrorCount >= 2` sau exhaust retries → set `lastErr.markDead = true`. `summarizeArticle` catch giờ check cả `err.fatal || err.markDead` → add vào `deadProviders` Set → candidate sau trong cùng run skip provider đó ngay.
  - **Tác động đo được**: dry-run worst-case (mọi provider dead từ candidate 1) chạy 9.5s thay vì worst-case cũ ~20 phút. Số bài/ngày dự kiến: 3-6 → 12-18.
  - **Test:** 117/117 unit pass (3 test mới: 408 fatal, ProviderError.markDead default, markDead settable). `tsc --noEmit` clean. Deploy `5b1332e0-53be-4d47-8198-7d2595d1fed8`.
  - **KHÔNG đổi**: bucket quota, MAX_AGE_HOURS, arxiv strict filter, fluff/path penalty, editorial scoring (ngoài scope).
- **Phase 18 (Apr 29, 2026) — Task 6: cảnh báo Telegram khi skip slot do thiếu bài**:
  - **Counter mới `skipped:YYYY-MM-DD`** (`worker/src/skipCounter.ts`): mỗi tick mà bot bỏ trống slot vì lý do `all candidates below MIN_SCORE_THRESHOLD` → tăng counter. Key TTL 36h, auto-reset mỗi ngày. Chỉ tăng khi `dryRun=false` để admin curl `/run?dry=1` thoải mái không làm sai counter.
  - **Cảnh báo Telegram tối đa 1 lần/ngày, có retry**: khi `count ≥ SKIP_ALERT_THRESHOLD = 3` VÀ flag `skipped_alert_sent:YYYY-MM-DD` chưa set → thử gửi. Set flag CHỈ KHI gửi thành công. Nếu Telegram down đúng tick count=3 → tick sau (count=4) sẽ retry, không miss alert. Khi flag đã set → silent hết ngày (không spam mỗi 2h). Gửi qua `sendAdminAlert()` mới ở `worker/src/telegram.ts` → endpoint `sendMessage` tới `TELEGRAM_ADMIN_CHAT_ID`.
  - **Env mới `TELEGRAM_ADMIN_CHAT_ID`** (optional): không set → tắt cảnh báo (counter vẫn chạy nền, có thể đọc qua `/stats.skippedSlotCount`). Set qua `wrangler secret put TELEGRAM_ADMIN_CHAT_ID`.
  - **`/stats` endpoint** trả thêm `skippedSlotCount` + `skippedSlotAlertThreshold` để admin debug được trực tiếp.
  - **Tách module `skipCounter.ts` (không nằm trong `storage.ts`)** vì storage.ts có runtime imports `./url.js`/`./dedup.js` không tương thích với `node --experimental-strip-types --test` (Node không tự rewrite `.js` → `.ts`). Module mới chỉ phụ thuộc KV (subset interface `SkipCounterKv`) → unit-test được trực tiếp với Map trong test.
  - **Test:** 115/115 unit pass (thêm 5 test mới: counter increment/độc lập theo ngày/corrupt-value/empty + flag flow với TTL & day-isolation). Lỗi gửi Telegram trong `sendAdminAlert` được catch tại chỗ → KHÔNG bao giờ throw lên pipeline chính (slot quan trọng hơn alert).
  - **Lý do KHÔNG sửa storage.ts:** giữ scope nhỏ, không churn module post-lifecycle. Counter là feature monitoring/alert độc lập → nằm riêng dễ đọc.
- **Phase 17 (Apr 29, 2026) — KV observability + write resilience (P0-A/B/C/P1)**:
  - **P0-A (AI quota):** xác nhận `worker/src/ai.ts` Phase 9.2 đã hỗ trợ `GOOGLE_API_KEY` + `GOOGLE_API_KEY_1.._5` rotation. Không sửa code. Hướng dẫn user trong Phase 15 vẫn áp dụng: thêm key qua `wrangler secret put GOOGLE_API_KEY_1` (mỗi key = 1 tài khoản Google = 1 quota free riêng).
  - **P0-B (KV namespace):** xác minh binding production. `wrangler.toml` bind `POSTED_KV` → id `70ab341227fd4badb90dfa2d761dde32`; mọi read/write trong code đều qua `env.POSTED_KV`. Deploy log + `/debug_kv` đều confirm cùng namespace, không có mismatch. Bot chỉ dùng MỘT binding duy nhất → an toàn theo thiết kế.
  - **P0-C (KV write observability):** refactor 4 `.catch(log)` tuần tự sau Telegram → `Promise.allSettled` qua helper `runKvOps()` (ở `diag.ts`). Mỗi op (clearFailCount / markTitlePosted / pushRecentTitle / incrementCategoryUsage / setLastPosted) giờ có per-op `{name, ok, ms, error}` trong log + bubble lên `RunResult.kvWrites`. Bot vẫn KHÔNG crash khi 1-2 write phụ fail (slot không bị mất), nhưng giờ thấy được fail nào ở đâu trong 1 dòng log + ngay trong response của `/run`.
  - **P1 (`/debug_kv` endpoint):** Bearer-protected. Write key tạm 60s TTL → read back → delete. Trả per-op latency + `matched`. Verify "binding sống" trong 1 request — không cần đợi cron tick. Đã smoke-test live: `put 211ms / get 8ms matched=true / delete 241ms / ✅ KV round-trip OK`.
  - **P1 (cron logging):** scheduled handler giờ log `cronExpr` + `scheduledTime` ở mở đầu, và 1-line summary `posted/attempted/title/reason/kvWrites` khi xong → cron-only run cũng có summary đầy đủ trong tail log (trước đây chỉ `/run` mới thấy `RunResult`).
  - **Verify hiện tại:** `/stats` cho 2026-04-29 = `core 0/6, ai 1/5, dev 0/4, research 0/1, trend 0/2` (1 bài đã post lúc 14:01 UTC). `/last` trả đúng "🛡️ OpenAI tung chiêu bảo vệ không gian mạng thời AI" qua `gemini-2.5-flash#k0`. KV không còn rỗng.
  - **Test:** 93/93 unit pass (thêm 12 test mới: `runKvOps`/`summarizeKvResults`/`probeKvRoundTrip` với fake KV). `tsc --noEmit` clean. Deploy `2b25dc0f-bb74-4bfa-8f7d-a132c113bf7a`.
- **Pipeline (Phase 1-7 upgrade)**:
  1. Fetch song song 18 nguồn → strict filter cho arxiv (chỉ paper LLM/AI)
  2. Score article: `sourceWeight + recency + keyword(boost-penalty) + primaryLab + engineering + depth − hnPenalty`
  3. Cluster intra-batch (jaccard ≥ 0.80) — winner = source priority thấp hơn
  4. KV check exact (URL + title hash) → fuzzy check (jaccard ≥ 0.88 vs 200 title gần nhất)
  5. **Min-score gate** (Phase 15 → Phase 18.5): bài score < **190** bị skip — thà bỏ slot còn hơn lấp bằng bài rác. Sau đó bucket selection theo quota cap: `core 6 / ai 5 / dev 4 / research 1 / trend 2 = 18` (cap, cron 24 tick/ngày từ Phase 18.5); fallback highest score nếu mọi bucket đầy
  6. **AI summarize chain (Phase 9 + 9.2)**: `{ title, bullets[], whyItMatters }` — `getProviders(env)` build chain động dựa trên env, dừng ở cái đầu tiên thành công. Thứ tự:
     1. **Gemini 2.5 Flash** (1 provider/key) — quality cao nhất, ưu tiên
     2. **Gemini 2.0 Flash** (1 provider/key) — quota cao hơn, fallback khi 2.5 cạn
     3. **OpenRouter Llama 3.3 70B Instruct** (free model — chỉ chạy khi có `OPENROUTER_API_KEY`)
     4. **OpenRouter Gemma 3 27B IT** (free model — provider khác để né upstream rate-limit của Llama)

     **Key rotation (Phase 9.2)**: nếu set `GOOGLE_API_KEY_1.._5` (mỗi key 1 tài khoản Google = 1 quota free riêng), bot tạo provider riêng cho mỗi (model × key), tên thành `gemini-2.5-flash#k0`, `#k1`, ... Thứ tự: tất cả key cho 2.5-flash trước → tất cả key cho 2.0-flash → OpenRouter. Chỉ 1 key thì giữ tên cũ "gemini-2.5-flash" (backward compat).

     **Circuit breaker (Phase 18.5)**: HTTP `429/401/403/408` + client-side timeout → fatal cho provider đó, fallback ngay sang provider kế VÀ add vào `deadProviders` Set (run-scoped) → candidate sau skip ngay. HTTP `5xx` → retry trong cùng provider (max 2); nếu lặp ≥ 2 lần → set `markDead` trên error → cũng add vào `deadProviders`. `PARSE_RETRIES_PER_PROVIDER=1`. Provider được dùng được log + ghi vào `last_posted_v1.provider`.
  7. Sau post: ghi posted/title/recent_titles/quota/last_posted (kèm `provider`)
- **Multi-candidate retry**: mỗi cron tick có sẵn full ranked list; nếu AI/Telegram fail bài đầu, tự thử bài tiếp theo
- **URL normalization**: dedupe dựa trên URL ĐÃ STRIP utm_*, fbclid, gclid, ref, fragment, sort params, lowercase host
- **Bundled với** `nodejs_compat`; RSS dùng `fast-xml-parser` + `fetch` (timeout 15s); Gemini gọi qua REST API (timeout 30s)

#### Required secrets (set qua `wrangler secret put`)

| Tên | Mô tả |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token từ @BotFather |
| `GOOGLE_API_KEY` | Gemini API key (provider 1+2 trong chain) |
| `GOOGLE_API_KEY_1` … `_5` | **Optional, recommended** — Gemini API key từ tài khoản Google KHÁC (mỗi key 1 quota free riêng). Bot tự xoay vòng (Phase 9.2). Khuyến nghị set ít nhất `_1` để giảm rủi ro cạn quota free tier. |
| `OPENROUTER_API_KEY` | **Optional** — API key từ openrouter.ai/keys (provider 3+4: Llama/Gemma free). Không set → bot vẫn chạy chỉ với Gemini như cũ. |
| `RUN_TRIGGER_TOKEN` | Token RIÊNG để bảo vệ endpoint `/run` (KHÔNG dùng chung Telegram token) |
| `TELEGRAM_ADMIN_CHAT_ID` | **Optional** — Chat ID nhận cảnh báo Telegram khi bot bỏ trống ≥ 3 slot/ngày do `all candidates below MIN_SCORE_THRESHOLD` (Task 6). Có thể là DM admin (vd `123456789`) hoặc channel test riêng (vd `@my_admin_alerts`). Không set → tắt cảnh báo (counter vẫn ghi vào KV, đọc qua `/stats.skippedSlotCount`). |

#### Required vars (in `wrangler.toml`)

`TELEGRAM_CHANNEL_ID`, `TELEGRAM_SIGNATURE`, `TELEGRAM_SIGNATURE_EMOJI`

#### HTTP endpoints

- `GET /health` — public ping (`200 ok`)
- `POST /run` — manual trigger ASYNC, **cần** `Authorization: Bearer <RUN_TRIGGER_TOKEN>`. Trả `202 Accepted`, chạy nền (xem log bằng `wrangler tail`).
- `POST /run?dry=1` — dry-run SYNC: chạy pipeline đầy đủ tới Gemini summarization NHƯNG không post Telegram. Trả JSON `{ runId, posted: false, attempted, postedTitle, ... }`. Hữu ích để verify format/quality.
- `GET /sources` — source health report, **cần Bearer**. Trả JSON liệt kê 18 nguồn + số bài fetched + ok/failed.
- `GET /stats` — quota usage hôm nay (mỗi bucket + total), **cần Bearer**.
- `GET /last` — bài cuối + 10 run gần nhất, **cần Bearer**.
- `GET /top_today` — top 10 candidate hiện tại + `topPreGate` (Phase 16: top 10 trước MIN_SCORE_THRESHOLD), **cần Bearer**.
- `GET /diag_ai` — Phase 16 diagnostic: probe từng AI provider trên 1 article giả, trả `{provider, ok, ms, error}`, **cần Bearer**. Dùng để confirm "provider nào sống/chết" mà không cần đợi cron tick.
- `GET /debug_kv` — Phase 17 diagnostic: write key tạm 60s TTL vào `POSTED_KV` → read lại → delete. Trả `{kvBinding, testKey, ops:[{op, ok, ms, matched?}], summary}`, **cần Bearer**. Verify binding KV production có ghi/đọc thực sự được không; status 500 nếu PUT fail.

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
