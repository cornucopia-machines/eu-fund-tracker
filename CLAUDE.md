# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Cloudflare Worker that scrapes EU funding opportunities from the EU Funding & Tenders Portal and serves them as an RSS feed. It's deployed to https://eu-fund-tracker.lorant-pinter.workers.dev/ and monitored via MonitorSS which converts updates to Discord messages.

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

### Core Flow

1. **Scheduled execution** (every 2 hours via cron): `scheduled()` handler in `src/index.ts:103` calls `buildAndStoreSnapshot()` which:
   - Fetches the EU portal HTML (via Puppeteer browser or direct fetch)
   - Parses opportunities from HTML using `parseOpportunities()`
   - Enriches each with AI-generated summaries via `enrichWithSummaries()`
   - Stores snapshot in KV namespace with 1-day TTL

2. **HTTP requests**: `fetch()` handler serves RSS XML from cached snapshot in KV. Supports:
   - `?regenerate=1` - force rebuild snapshot
   - `?limit=N` - limit number of new summaries when regenerating
   - `?html=...` - test mode to parse injected HTML directly (no KV required)
   - `?url=...` - override target URL (defaults to `DEFAULT_FEED_URL`)

### Key Components

**`src/parsePage.ts`**: HTML parsing logic
- `parseOpportunities()` - Extracts opportunity cards from portal HTML using linkedom DOM parsing. Handles complex identifier/metadata extraction from various card structures.
- `itemsToRssXml()` - Converts opportunities array to RSS 2.0 XML

**`src/summarize.ts`**: AI summarization
- `enrichWithSummaries()` - Loops through opportunities, fetches detail pages, generates AI summaries using Workers AI. Caches summaries in KV with 2-week TTL. Respects `limit` parameter to control new summaries per run.
- `summarizeLink()` - Fetches opportunity detail page (via Puppeteer or fetch), converts HTML to markdown, calls Workers AI with custom prompt to generate summary + relevance score
- Custom prompt asks for summary + relevance score (0-100) for a smart IoT irrigation product for home gardeners

**`src/index.ts`**: Main worker entry point with fetch/scheduled handlers

**`src/types.ts`**: TypeScript interfaces for `Opportunity`, `Env`, `SummarizeOptions`

### Cloudflare Bindings

Configured in `wrangler.toml`:
- **BROWSER**: Puppeteer browser instance for headless Chrome rendering
- **SUMMARIES**: KV namespace for caching snapshots and individual summaries
- **AI**: Workers AI binding for LLM-based summarization (defaults to `@cf/meta/llama-3.1-8b-instruct`)
- **SUMMARY_MODEL**: Optional environment variable to override AI model

### Test Setup

Uses `@cloudflare/vitest-pool-workers` to run tests in Workers environment with access to bindings. See `vitest.config.mts`.

## Common Patterns

### Browser vs Fetch Mode

Code supports two modes for fetching HTML:
- **Browser mode**: Uses `@cloudflare/puppeteer` when `env.BROWSER` binding is available - needed for JavaScript-rendered content
- **Fetch mode**: Direct HTTP fetch as fallback - faster but may miss dynamic content

Both `fetchListingHtml()` (src/index.ts:10) and `summarizeLink()` (src/summarize.ts:66) support both modes via optional `browserPage` parameter.

### KV Caching Strategy

Two-level caching:
1. **Snapshot cache** (`SNAPSHOT_KEY`): Full opportunity list with summaries, 1-day TTL
2. **Individual summary cache**: Per-URL summaries, 2-week TTL

This allows rebuilding snapshots without regenerating all summaries.

### Parsing Heuristics

`parseOpportunities()` uses multiple fallback strategies to extract metadata (identifier, dates, status, etc.) from varying HTML structures. It attempts structured DOM queries first, then regex fallbacks. This robustness is critical since the EU portal HTML structure varies across opportunity types.
