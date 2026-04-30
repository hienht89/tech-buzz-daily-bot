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
- **Phase 20 (Apr 30, 2026) — Telegram Admin Bot + Proactive Alerts**:
  - **Yêu cầu user**: quản lý bot từ điện thoại (không phải mở browser/curl), bot tự cảnh báo khi có sự cố. Dùng chung 1 bot @techbuzz_daily (không tạo bot mới) — token cũ đã có quyền sendMessage, chỉ cần thêm webhook receive update.
  - **Files mới**: `worker/src/admin.ts` (~470 lines, command router), `worker/src/alerts.ts` (~210 lines, throttled alert helpers).
  - **Endpoints mới** (index.ts):
    - `POST /telegram/webhook` — Telegram → bot. Verify header `X-Telegram-Bot-Api-Secret-Token` = `env.TELEGRAM_WEBHOOK_SECRET` (timing-safe). Parse update, ack 200 ngay, run handler async qua `ctx.waitUntil` (tránh Telegram retry timeout).
    - `POST /telegram/setup` (Bearer) — gọi Telegram setWebhook trỏ về `<origin>/telegram/webhook` với secret_token. Idempotent, gọi lại OK.
  - **Authorize**: chỉ `message.chat.id === env.TELEGRAM_ADMIN_CHAT_ID` mới process; chat khác silent ignore (không leak bot existence). Webhook secret + admin chat ID đều set qua wrangler secret.
  - **Commands**: `/start`, `/help` — menu; `/queue` — list 18 slot (giờ VN, source, title, age); `/sources` — fetch 27 RSS, list dead + top OK (slow ~5-10s, ack first); `/quota` — probe 9+ AI providers (slow ~10-30s, ack first); `/refill` — trigger refill async qua callback `triggerRefill`; `/clear_queue YES` — xoá toàn bộ slot (yêu cầu xác nhận "YES"); `/skip <giờ>` — xoá slot giờ VN cụ thể (vd `/skip 14` = bỏ 14h hôm nay UTC 7h); `/stats` — bucket usage hôm nay + queue len + last posted; `/health` — KV roundtrip probe.
  - **Alerts proactive (4 loại, throttle 6h/loại qua KV TTL)**:
    1. `alertQueueLow` — sau refill nếu `listQueue().length < QUEUE_OK_MIN=6`.
    2. `alertAiKeysExhausted` — refill `failed >= AI_KEY_EXHAUSTED_FAIL_THRESHOLD=12` (2/3 of 18 slots).
    3. `alertConsecutivePostFailures` — post fail liên tiếp `>= POST_FAIL_ALERT_THRESHOLD=3` (KV counter `alert:postfail:streak`, reset on success).
    4. `alertRefillFailed` — refill cron throw exception (catch block trong scheduled handler).
  - **Hooks**: scheduled handler refill `.then(checkRefillAlerts)` + `.catch(alertRefillFailed)`; post `.then(checkPostAlerts)` + `.catch(incrementPostFailStreak + alert)`.
  - **Throttle implementation**: `alerts.ts` `sendThrottledAlert(env, type, text)` — KV key `alert:throttle:<type>` với TTL 6h. Read → skip if exists. Write after sendAdminAlert success. Lỗi KV → vẫn cố gửi (no-throw, log warn).
  - **Secrets mới**: `TELEGRAM_ADMIN_CHAT_ID = 5787008349` (DM Telegram của user, lấy từ @userinfobot), `TELEGRAM_WEBHOOK_SECRET` (random hex 48 chars, generate `openssl rand -hex 24`).
  - **Setup flow**: (1) `wrangler secret put TELEGRAM_ADMIN_CHAT_ID`, (2) `wrangler secret put TELEGRAM_WEBHOOK_SECRET`, (3) `wrangler deploy`, (4) `curl -X POST -H "Bearer ..." /telegram/setup` — Telegram trả `{ok: true, "Webhook was set"}`.
  - **Performance**: webhook handler ack 200 ngay (<200ms). Slow commands (sources/quota/refill) reply "Đang xử lý..." trước, kết quả gửi qua second message khi done — Telegram không timeout webhook.
  - **Verify deploy `f51f614b`**: tests 156/156 pass; webhook setWebhook OK; user gửi /start nhận menu.
- **Phase 19.9 (Apr 30, 2026) — Refill ngoài khung post + cap 2 bài/nguồn**:
  - **Vấn đề user nêu (1)**: refill cron 06:30/35/40 UTC = 13:30 chiều VN, RƠI vào khung post (UTC 0-17 = 7h sáng → 0h khuya VN) → 2 cron có thể chạy đan xen, share AI quota. **Vấn đề (2)**: queue có thể có 3-4 bài cùng nguồn liên tiếp (vd 3× AWS, 4× Wired) — không đa dạng.
  - **Fix (1)**: `wrangler.toml` cron đổi `"30/35/40 6 * * *"` → `["0 22 * * *", "5 22 * * *", "10 22 * * *"]` = 5h00/05/10 sáng VN. Khung không-post là UTC 18:00-23:59 (= 1h-7h sáng VN); chọn UTC 22 để có 2h đệm trước cron post đầu (UTC 0:00 = 7h sáng VN). `index.ts` `REFILL_CRON_EXPRS` Set update theo. Trade-off: mất "Mỹ giờ làm" boost (UTC 22 = 14h PT) nhưng quota Gemini per-key nên không bị share đáng kể.
  - **Fix (2)**: `runQueueRefill` thêm const `MAX_PER_SOURCE_QUEUE = 2`. Init `queuedSourceCount` Map từ `listQueue()` loop. Sau `interleaveByCategory` ordering, loop qua `ordered` candidates: nếu `queuedSourceCount.get(source) >= 2` → skip, else push vào `capped[]` + tăng counter. `primaries = capped.slice(0, slotsToFill)`, `fallbackPool = capped.slice(slotsToFill)`. Log mỗi refill: `Per-source cap: skipped X candidates`.
  - **Test**: 156/156 pass; rename test "refill từ 06:30 UTC" → "refill từ giữa khung post" (timestamp vẫn dùng làm sample math, không tied to cron value).
  - **Verify deploy `2d9d3ba2`**: typecheck clean, schedule mới `0 0-17 * * *` + 3× `_ 22 * * *` đăng ký OK với Cloudflare.
- **Phase 19.8.1 (Apr 30, 2026) — Mở rộng pool nguồn từ 21 → 27 + tăng trust score**:
  - 6 nguồn mới: MIT Tech Review, Y Combinator Blog, NVIDIA Blog, MIT News AI, Pragmatic Engineer, Linear Blog. DOMAIN_TRUST_TABLE +12..+22 cho các nguồn tier-1. NVIDIA/MIT News AI vào PRIMARY_LAB_SOURCES, Pragmatic/Linear vào ENGINEERING_BLOG_SOURCES.
  - Verify dead: Anthropic, Mistral, OpenAI Research (404), Microsoft AI (403). Loại Engadget/9to5Google/MacRumors/Smashing/Sequoia/VentureBeat/Crunchbase do consumer/business focus.
  - Set Gemini key thứ 9 (`GOOGLE_API_KEY_8`) qua wrangler secret put — quota hồi, refill seed 12+ slot OK. Deploy `0043917c`.
- **Phase 19.8 (Apr 30, 2026) — Queue-based pre-generated scheduling (Hướng C)**:
  - **Vấn đề user nêu**: post tick `0 0-17 * * *` chạy lúc người Mỹ peak hours (UTC 13-17 = giờ làm việc EST/PST). AI providers (Gemini free tier) bị share traffic → 429 cao, miss slot. User chốt Hướng C: refill queue lúc Mỹ ngủ (06:30 UTC = ~22:30 PT), post tick chỉ đọc queue.
  - **Architecture**: `worker/src/queue.ts` — KV slot key `queue:YYYY-MM-DDTHH` UTC, TTL 36h. API: `slotKeyForUTC`, `enumerateNextPostSlots`, `peekSlot`, `enqueueSlot`, `dequeueSlot`, `clearSlot`, `listQueue`, `articleToJson`/`articleFromJson`.
  - **`runQueueRefill`** (`worker/src/index.ts`): chunked parallel (REFILL_PARALLEL_CHUNK=6) + `interleaveByCategory` diversity + **enqueue inline** trong `trySummarizeAndEnqueue` (vì waitUntil cancel ~30s — nếu enqueue cuối, mất hết). Overfetch 2x candidates phòng AI fail. Round 1 fill primaries → fallback round retry slot fail từ pool. **Dedup queued (CRITICAL FIX)**: trước khi `pickCandidates`, gom `canonicalUrl`/`link`/`titleHash`/raw `title` của tất cả slot đang queue (qua `listQueue`) → pass vào `pickCandidates` 3 param mới (`extraSkipUrls`, `extraSkipTitleHashes`, `extraFuzzyTitles`). Hai layer dedup: (1) exact URL/hash skip ngay sau `isPosted`/`isTitlePosted`; (2) **queued-fuzzy threshold 0.75** (thấp hơn default 0.88) chỉ apply cho queued window — catch case multi-source cùng event (Elon Musk drama, SoftBank IPO etc) mà raw title Jaccard ~0.6-0.8.
  - **`runQueuePost`**: tick `0 0-17 * * *` đọc `dequeueSlot(currentHourSlot)` → `reservePost` → `postArticle` → bucket count. Fallback `runBot` realtime nếu queue empty hoặc race-condition (KV inconsistency).
  - **Cron schedule** (`wrangler.toml`): `0 0-17 * * *` (post 18 tick) + `30 6 * * *` + `35 6 * * *` + `40 6 * * *` (3 refill ticks 5min apart làm backup vì waitUntil cap ~30s chỉ fill được 4-6 slot/tick — cần 3 lần để đảm bảo 18 slot full).
  - **Endpoints mới (Bearer)**: `GET /queue` (list slot + title + provider + ageMin), `POST /refill` (manual trigger async, `?sync=1` để debug đồng bộ), `POST /clear_queue` (xoá toàn bộ queue, ops only).
  - **Test**: 156/156 pass (+14 test mới: slot key UTC, `enumerate` từ now, `articleToJson` roundtrip, enqueue/peek/dequeue, corrupt JSON skip, listQueue sort theo slot key, idempotent re-enqueue cùng slot).
  - **Sự cố observability hôm deploy**: refill manual chạy trong ngày test cạn quota Gemini (8 keys × 2 model HTTP 429 hết) + Cloudflare subrequest cap → enqueue 0 bài. Code dedup KHÔNG có lỗi, chỉ AI quota issue tạm thời. Cron 06:30/35/40 UTC ngày kế tiếp sẽ tự fill khi quota reset (00:00 PT).
  - **Verify deploy `30522651`**: trong khi quota còn → 4 lần manual /refill seed được 18/18 slot, không duplicate. Trước khi có dedup queue, queue có duplicate (3× SoftBank, 3× CloudWatch, 4× Elon Musk drama) — sau fix sạch hết.
- **Phase 19.7 (Apr 30, 2026) — Bilingual hybrid: kênh phục vụ cả người VN + người nước ngoài**:
  - **Yêu cầu user**: kênh @techbuzz_daily không chỉ cho người Việt mà cả người nước ngoài đọc được. User chốt **Hướng 3 (hybrid nhẹ)** sau khi mình tư vấn 3 hướng — giữ 1 channel, content VN làm chính, thêm 1 dòng EN TL;DR + hashtag EN cuối caption. Lý do: brand "Tech Buzz Daily" sẵn EN, source RSS đã EN nên không cần dịch ngược (cost AI minimal), kênh đang xây audience không nên chia 2, user non-tech khó maintain 2 channel.
  - **Schema mới**: `Summary` thêm 2 field optional `enTldr` (1 câu English ≤200 chars, neutral journalistic tone) + `hashtags` (string[] alphanumeric ASCII, sanitize qua `sanitizeRawHashtags`). Backward compat: schema cũ thiếu 2 field → empty string/array, formatCaption tự skip section.
  - **Prompt AI** (`worker/src/ai.ts`): yêu cầu Gemini sinh thêm `enTldr` + `hashtags` trong cùng JSON response (không tăng số API call, chỉ tăng input/output tokens nhẹ). Quy tắc: enTldr KHÔNG emoji/Việt, neutral tone; hashtags 3-5 từ keyword chính bài, alphanumeric only.
  - **Format caption mới** (`worker/src/telegram.ts` `formatCaption`): thêm separator `━━━━━━━━━━` + `🌐 <i>EN:</i> {enTldr}` sau `whyItMatters`, hashtag line cuối cùng (sau signature). Brand hashtag `#TechBuzzDaily` auto-append (case-insensitive dedupe) — nhưng CHỈ khi AI có ≥1 hashtag (tránh hiện brand đơn độc khi backward compat).
  - **Smart truncation** priority (drop từ thấp → cao khi tràn 1024 char cap):
    1. Drop hashtag line trước (chỉ là discovery aid).
    2. Drop EN section (separator + EN line) — người Việt vẫn đọc đủ.
    3. Cắt bullets từ cuối (existing).
    4. Last resort: cắt link text giữ href.
  - **Verify deploy `5cb62e0d`**: trigger manual lúc 03:41 UTC → bot post bài "👻 GPT-5 bị 'ma ám'? OpenAI giải mã mấy cái quirk tính cách siêu dị của AI!" (provider gemini-2.5-flash#k2, score 259, category ai). totalToday 5→6.
  - **Test**: 142/142 pass (+9 test mới: render full layout, backward compat, drop hashtag tight, drop both rất tight, buildHashtagList với brand append + dedupe + cap 5, sanitizeRawHashtags với 6 case).
  - **KHÔNG đổi**: cron schedule (vẫn `0 0-17 * * *` Phase 19.6), bucket quota, scoring, AI provider chain, threshold logic.
- **Phase 19.6 (Apr 30, 2026) — Always-post: 18 bài/ngày guarantee, không miss slot**:
  - **Yêu cầu user**: bot phải post ĐÚNG 18 bài/ngày từ 7h sáng đến 0h khuya VN, không miss slot nào, đăng đúng giờ. Philosophical shift từ "thà skip còn hơn post rác" → "luôn post bài tốt nhất hiện có".
  - **3 thay đổi đồng thời**:
    1. **Cron `0 * * * *` (24 tick) → `0 0-17 * * *` (18 tick)** (`worker/wrangler.toml`). VN=UTC+7 → 7h VN = 0h UTC, 0h VN = 17h UTC. Bỏ post đêm 1h-6h sáng VN.
    2. **Bỏ skip-low-score gate** trong `pickCandidates` (`worker/src/index.ts`). Threshold động vẫn được tính + log + hiển thị ở `/stats` để diagnostic, nhưng KHÔNG dùng để skip nữa. Mọi bài qua filter (tech URL + tech title + arxiv strict + dedup) đều thành candidate. `skippedLowScore` field vẫn tồn tại nhưng giờ là counter informational, không phản ánh skip thật.
    3. **Nới bucket quota** (`worker/src/bucket.ts` `DEFAULT_QUOTA`): core 6→8, ai 5→7, dev 4→6, research 1→3, trend 2→4 (tổng 18→28). Cap rộng hơn để giảm bottleneck khi 1 category chiếm pool, nhưng vẫn giữ "fallback highest score chung" làm safety net khi mọi bucket đầy.
  - **Cleanup**: `maybeAlertSkippedSlot` không còn được gọi (giữ function + `skipCounter.ts` để bật lại sau nếu cần monitoring). Cập nhật jsdoc Phase 19.6 cho `Env.TELEGRAM_ADMIN_CHAT_ID`, `MIN_SCORE_THRESHOLD` jsdoc block, `PickResult` field comments, log message "below threshold ... [informational, KHÔNG skip]".
  - **Verify deploy `60b23d93`**: cron lock đúng `0 0-17 * * *`. Manual trigger lúc 03:17 UTC → bot post được bài "Microsoft reports sinking Xbox revenue" (score=201) trong khi threshold dynamic = 211 — bài này TRƯỚC ĐÂY sẽ bị skip vì 201 < 211. totalToday 4 → 5, usage `core 2/8, ai 2/7, dev 1/6, research 0/3, trend 0/4`. ✓
  - **Test**: 133/133 pass (cập nhật 2 test bucket cho quota mới: `trend 2→4` full marker, `core 6/6→8/8(full)` + `ai 1/5→1/7`).
  - **Trade-off đã trao đổi với user**: (a) đôi khi giờ tin yếu (10h-14h trưa VN = đêm Mỹ) bài có thể chất lượng trung bình thay vì xuất sắc — vẫn không phải bài rác vì qua 4 lớp filter; (b) Cloudflare cron có thể trễ 1-3 phút so với giây 0 (giới hạn nền tảng).
  - **KHÔNG đổi**: scoring algo, dedup logic, AI provider chain (8 Gemini key + OpenRouter), Telegram channel/admin chat ID, MAX_AGE_HOURS, MAX_CANDIDATES_PER_RUN.
- **Phase 19.5 (Apr 30, 2026) — Threshold tuning chống miss slot (post-Task #7)**:
  - **Vấn đề quan sát**: User báo bot bỏ slot 2h liên tiếp dù đã có 8 key Gemini khoẻ. `/top_today` cho thấy: 200 fetched / 138 tech / 122 scored / **eligible=0** / skippedLowScore=104. Nguyên nhân: Task #7 (Phase 19) hardcode `FALLBACK_THRESHOLD = 220` đè lên Phase 18.5 (190); historyCount=7 < MIN=20 → kẹt ở fallback 220 quá khắt khe trong cold-start.
  - **4 thay đổi đồng thời** (`worker/src/threshold.ts`):
    - `FALLBACK_THRESHOLD: 220 → 195` — gần với Phase 18.5 (190), buffer +5 vì đã có thêm filter strict.
    - `DEFAULT_PERCENTILE: 0.4 → 0.25` (p40 → p25). Lý do: history hôm nay p40=234, p25 ≈ 212 — đủ chặn rác mà không skip slot vào giờ tin yếu.
    - `MIN_HISTORY_FOR_DYNAMIC: 20 → 10`. Lý do: 12-18 tick/ngày → 10 mẫu = 12-20h thay vì 30h+. Bot kích hoạt dynamic ngay trong ngày deploy.
    - `MIN_CLAMP: 180 → 170`. Cho dynamic mode dư địa hạ thấp khi nguồn yếu — clamp 260 trên vẫn chặn.
  - **Verify deploy `e5d03665`**: ngay sau deploy `/top_today` cho **eligible=3** (trước 0), `skippedLowScore=0` (trước 104). Manual trigger lúc 02:55 UTC → bot post được "Musk v. Altman" (score 207) — slot 03:00 đáng lẽ bị skip.
  - **Test**: 133/133 unit pass (cập nhật 5 test threshold để khớp constants mới + đổi label "p40" → "p25" trong log `index.ts`).
  - **Tác động dự kiến**: hết miss slot trong cold-start (1-2 ngày đầu sau reset KV); ngày bình thường dynamic mode tự cân bằng; clamp 260 vẫn bảo vệ chất lượng khi nguồn "đại bịch".
  - **KHÔNG đổi**: bucket quota, MAX_AGE_HOURS, scoring/dedup, AI provider chain.
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
