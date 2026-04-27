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

Standalone Telegram bot in `scripts/` that fetches RSS tech news, summarizes with Gemini AI, and posts to a Telegram channel every 2 hours via GitHub Actions.

- Entry point: `scripts/src/postNews.ts`
- Modules: `scripts/src/lib/{rss,ai,telegram,storage,sources}.ts`
- Cron workflow: `.github/workflows/post-news.yml`
- Posted history: `scripts/data/posted.json` (committed by Actions)
- Deployment guide: `scripts/BOT_README.md`
- Required env vars: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHANNEL_ID`, `GOOGLE_API_KEY`
