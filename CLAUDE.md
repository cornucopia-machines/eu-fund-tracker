# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Cloudflare Worker that scrapes EU funding opportunities from the EU Funding & Tenders Portal and posts them to Discord via webhooks. It uses a queue-based architecture with three modules (Crawler, Summarizer, Notifier) that run on separate cron schedules. The worker is deployed to https://eu-fund-tracker.lorant-pinter.workers.dev/.

## Development Commands

```bash
# Run tests (uses Vitest with Cloudflare Workers pool)
npm test

# Run worker locally in dev mode
npm run dev
# or
npm start

# Deploy to Cloudflare Workers
npm run deploy

# Generate TypeScript types from wrangler.toml bindings
npm run cf-typegen
```

### Running Individual Tests

```bash
# Run specific test file
npx vitest run test/parsePage.spec.ts

# Run tests in watch mode
npx vitest
```

## Architecture

### Three-Module Queue System

The system uses three independent modules that communicate via KV-based queues:

1. **Crawler Module** (runs every 2 hours):

   - Fetches EU portal HTML via Puppeteer or direct fetch
   - Parses opportunities using `parseOpportunities()`
   - Checks each URL against "seen" set in KV for deduplication
   - Enqueues new opportunities to summarization queue
   - Marks URLs as seen to prevent reprocessing

2. **Summarizer Module** (runs every 15 minutes):

   - Polls summarization queue for pending jobs (batch: 5)
   - Claims jobs using processing locks to prevent concurrent processing
   - Generates AI summaries via Workers AI (reuses summary cache)
   - Enqueues completed summaries to notification queue
   - Implements retry logic with exponential backoff (max 3 attempts)

3. **Notifier Module** (runs every 5 minutes):
   - Polls notification queue for completed summaries (batch: 10)
   - Claims jobs using processing locks
   - Posts rich Discord embeds to webhook
   - Handles rate limiting (429 responses) with retry
   - Implements retry logic with max 5 attempts

### HTTP Endpoint

The `fetch()` handler now returns a simple health check JSON response instead of serving RSS.

### Key Components

**Modules** (`src/modules/`):

- `crawler.ts` - Discovers new opportunities and queues them
- `summarizer.ts` - Processes summarization queue with AI
- `notifier.ts` - Posts to Discord webhook

**Shared Utilities** (`src/shared/`):

- `queue.ts` - KV-based queue operations (enqueue, claim, release, complete, fail)
- `dedup.ts` - URL deduplication tracking (hash-based seen set)
- `discord.ts` - Discord webhook client and embed formatting

**Core Logic**:

- `src/parsePage.ts` - Extracts opportunity cards from portal HTML using linkedom
- `src/summarize.ts` - AI summarization via Workers AI with custom prompt
- `src/index.ts` - Main entry point that routes cron events to modules
- `src/types.ts` - TypeScript interfaces

### Cloudflare Bindings & Environment

Configured in `wrangler.toml`:

- **BROWSER**: Puppeteer browser instance for headless Chrome rendering
- **SUMMARIES**: KV namespace for queues, seen tracking, and summary caching
- **AI**: Workers AI binding for LLM-based summarization
- **DISCORD_WEBHOOK_URL**: Secret containing Discord webhook URL (set via `wrangler secret put`)

Environment variables:

- `CRAWLER_BATCH_SIZE`, `SUMMARIZER_BATCH_SIZE`, `NOTIFIER_BATCH_SIZE`: Control batch sizes
- `MAX_SUMMARIZE_ATTEMPTS`, `MAX_NOTIFY_ATTEMPTS`: Retry limits before moving to DLQ

### Test Setup

Uses `@cloudflare/vitest-pool-workers` to run tests in Workers environment with access to bindings. See `vitest.config.mts`.

## Common Patterns

### KV Queue Schema

Queues are implemented using KV with timestamp-prefixed keys:

- **Summarization queue**: `queue:summarize:{timestamp}:{urlHash}`
- **Notification queue**: `queue:notify:{timestamp}:{urlHash}`
- **Processing claims**: `processing:{urlHash}` (15-min TTL, auto-releases on crash)
- **Seen URLs**: `seen:{urlHash}` (90-day TTL)
- **Dead letter queue**: `dlq:summarize:{urlHash}` or `dlq:notify:{urlHash}` (30-day TTL)

### Claim/Release Pattern

To prevent concurrent processing:

1. Module polls queue for pending items
2. Attempts to claim each job via `processing:{urlHash}` key
3. If already claimed, skips to next job
4. Processes job, then either completes (deletes) or fails (increments attempts)
5. Processing claims auto-expire after 15 minutes if worker crashes

### Retry & DLQ Strategy

- Summarizer: Max 3 attempts (failures often permanent like 404s)
- Notifier: Max 5 attempts (failures often transient like rate limits)
- Failed jobs increment attempt counter and store error message
- After max attempts, jobs move to Dead Letter Queue for debugging
- Rate limit errors (429) release claim immediately for fast retry

### Discord Embed Format

Rich embeds with status-based color coding:

- Green (Open), Blue (Forthcoming), Gray (Closed), Red (Cancelled), Orange (Suspended)
- Fields: Identifier, Status, Type, Opening/Deadline dates, Programme, Action Type
- Description contains AI-generated summary
- Rate limiting: 200ms delay between posts, max 10 per 5-minute run = 2 req/min (safe)
