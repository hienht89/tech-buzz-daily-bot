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
- `pnpm --filter @workspace/scripts run post-news` — run Tech Buzz Daily bot once

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Tech Buzz Daily Bot

Telegram bot that fetches RSS tech news, summarizes with Gemini AI, and posts to `@techbuzz_daily` every 2 hours at exact odd-hour Vietnam time marks (1:00, 3:00, 5:00, ...).

### Cloudflare Workers (PRIMARY — `worker/`)

Migrated from GitHub Actions because GH Actions cron drifted 30–60min at night. Cloudflare Cron Triggers fire within seconds of the scheduled UTC time.

- Entry point: `worker/src/index.ts` (exports `scheduled` + `fetch` handlers)
- Modules: `worker/src/{rss,ai,telegram,storage,sources}.ts`
- Config: `worker/wrangler.toml` (cron `0 */2 * * *` UTC = odd hours VN)
- Storage: Cloudflare KV namespace `POSTED_KV` (replaces `posted.json`)
- Bundled with `nodejs_compat`; RSS uses `fast-xml-parser` + `fetch`; Gemini called via REST API
- Required secrets (set via `wrangler secret put`): `TELEGRAM_BOT_TOKEN`, `GOOGLE_API_KEY`
- Required vars (in `wrangler.toml`): `TELEGRAM_CHANNEL_ID`, `TELEGRAM_SIGNATURE`, `TELEGRAM_SIGNATURE_EMOJI`
- Manual trigger: `GET https://<worker-url>/run?token=<TELEGRAM_BOT_TOKEN>`

### GitHub Actions (BACKUP — `scripts/`)

Original Node.js implementation, kept as fallback. Disable cron in `.github/workflows/post-news.yml` once Cloudflare Worker is verified.

- Entry point: `scripts/src/postNews.ts`
- Modules: `scripts/src/lib/{rss,ai,telegram,storage,sources}.ts`
- Cron workflow: `.github/workflows/post-news.yml`
- Posted history: `scripts/data/posted.json` (committed by Actions)
- Deployment guide: `scripts/BOT_README.md`
- Required env vars: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHANNEL_ID`, `GOOGLE_API_KEY`
