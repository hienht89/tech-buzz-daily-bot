# techbuzz-worker

Cloudflare Worker bot — fetch RSS tech, score + dedupe, summarize qua Gemini, post lên Telegram channel `@techbuzz_daily` mỗi giờ 7h–0h VN (18 bài/ngày).

## Cấu trúc

```text
worker/
├── src/
│   ├── index.ts       # scheduled + fetch handlers (entry)
│   ├── sources.ts     # 18 nguồn RSS chia 5 category + priority
│   ├── rss.ts         # fetch + parse RSS, normalize Article
│   ├── filter.ts      # keyword boost/penalty, arxiv strict relevance
│   ├── score.ts       # tổng điểm: source + recency + keyword + lab + depth - hnPenalty
│   ├── dedup.ts       # 3 lớp dedup: exact (URL+title), fuzzy trigram, intra-batch event cluster
│   ├── bucket.ts      # quota bucket selection (core/ai/dev/research/trend)
│   ├── url.ts         # canonical URL normalize
│   ├── storage.ts     # KV wrappers (posted, title, recent_titles, quota, last_posted, failed)
│   ├── ai.ts          # Gemini call + parse Summary { title, bullets[], whyItMatters }
│   └── telegram.ts    # gửi photo/text + format caption HTML, smart truncate
├── test/run-tests.ts  # 60 unit tests (Node --test)
├── wrangler.toml      # cron + KV binding + vars
└── package.json
```

## Pipeline mỗi cron tick

1. Fetch song song 18 nguồn RSS (timeout 15s).
2. Filter: arxiv → strict relevance check (chỉ paper LLM/AI).
3. Score: `sourceWeight + recency(48h decay) + keyword(boost-penalty) + primaryLab + engineering + depth − hnPenalty`.
4. Cluster intra-batch (jaccard ≥ 0.80) — winner = source priority thấp hơn (gốc thắng aggregator).
5. KV exact check (URL hash + normalized title hash).
6. Fuzzy check (jaccard ≥ 0.88 vs 200 title gần nhất).
7. Bucket quota: `core 5 / ai 5 / dev 4 / research 2 / trend 2`. Fallback highest score nếu mọi bucket đầy.
8. Gemini summarize (timeout 30s, retry 3 lần parse JSON).
9. Format caption HTML (bullets + 💡 Vì sao đáng đọc + signature + link).
10. Crawl og:image; gửi photo (≤1024 char caption) hoặc text (≤4096 char).
11. Mark posted + push recent_title + increment quota + ghi last_posted.

Nếu Gemini/Telegram fail bài đầu, lặp candidate kế tiếp cho đến khi post được hoặc hết.

## KV layout

| Key | TTL | Mục đích |
|---|---|---|
| `posted:<sha1(url)>` | 30d | dedupe URL exact |
| `title:<sha1(normTitle)>` | 30d | dedupe cùng title từ URL khác |
| `recent_titles_v1` | none | 200 title gần nhất (fuzzy compare) |
| `quota:YYYY-MM-DD:<cat>` | 48h | đếm bài/bucket trong ngày |
| `last_posted_v1` | none | bài cuối + 10 run history |
| `failed:<sha1(url)>` | 24h | poison counter |

## Endpoints

| Method | Path | Auth | Mô tả |
|---|---|---|---|
| GET | `/health` | — | ping public |
| POST | `/run` | Bearer | trigger async, 202 |
| POST | `/run?dry=1` | Bearer | dry-run sync (không post Telegram) |
| GET | `/sources` | Bearer | source health report |
| GET | `/stats` | Bearer | quota usage hôm nay |
| GET | `/last` | Bearer | bài cuối + run history |

`Authorization: Bearer $RUN_TRIGGER_TOKEN`

## Commands

```bash
# từ thư mục worker/
npm test                  # 60 unit tests
npx tsc --noEmit          # typecheck
npx wrangler deploy       # deploy production
npx wrangler tail         # stream logs
npx wrangler dev          # local dev (cần secrets local)
```

## Secrets cần set

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put GOOGLE_API_KEY
npx wrangler secret put RUN_TRIGGER_TOKEN
```

## Tunables nhanh

- `worker/src/score.ts` — đổi weight các thành phần.
- `worker/src/dedup.ts` — `FUZZY_THRESHOLD` (0.88), `EVENT_THRESHOLD` (0.80), `RECENT_TITLES_CAP` (200).
- `worker/src/bucket.ts` — `DEFAULT_QUOTA` (5/5/4/2/2 = 18).
- `worker/src/filter.ts` — boost/penalty keyword list.
- `worker/src/sources.ts` — thêm/bớt RSS, đổi category/priority.

## Lưu ý

- Worker này KHÔNG nằm trong pnpm workspace (standalone trong `worker/`). Chạy thẳng bằng `npm` / `npx`.
- Internal value import giữa src/* dùng `.js` ext (cho wrangler/esbuild). Riêng `score.ts → filter.ts` dùng `.ts` ext vì test runner Node `--experimental-strip-types` không tự rewrite `.js → .ts` cho value import.
