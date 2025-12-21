# Implementation Plan: RSS to Discord Push Notifications

## Overview

Refactor from pull-based RSS to push-based Discord notifications using a three-module queue architecture:
1. **Crawler** - Discovers new opportunities, queues for summarization
2. **Summarizer** - Generates AI summaries, queues for notification
3. **Notifier** - Posts to Discord webhook

## Architecture Decisions

- **Queue mechanism**: KV + polling pattern (no native Queue binding)
- **RSS feed**: Remove completely
- **Discord webhook**: Environment variable `DISCORD_WEBHOOK_URL`
- **Deduplication**: Track seen URLs in KV

## File Structure

```
src/
├── index.ts                  # UPDATED: Route cron events to modules, remove RSS
├── types.ts                  # UPDATED: Add new interfaces
├── modules/
│   ├── crawler.ts            # NEW: Discover & queue new opportunities
│   ├── summarizer.ts         # NEW: Generate AI summaries
│   └── notifier.ts           # NEW: Post to Discord
├── shared/
│   ├── queue.ts              # NEW: KV queue utilities
│   ├── dedup.ts              # NEW: Deduplication tracking
│   └── discord.ts            # NEW: Discord webhook client
├── parsePage.ts              # UPDATED: Remove RSS XML generation
└── summarize.ts              # Keep existing summarizeLink logic
```

## KV Schema

### 1. Seen URLs Tracking
- **Key**: `seen:{urlHash}` (hash of opportunity URL)
- **Value**: `{url, firstSeen, identifier, title}`
- **TTL**: 90 days

### 2. Summarization Job Queue
- **Key**: `queue:summarize:{timestamp}:{urlHash}`
- **Value**: `{url, opportunity, enqueued, attempts, lastAttempt?, error?}`
- **TTL**: 7 days

### 3. Processing Claims (prevent concurrent processing)
- **Key**: `processing:{urlHash}`
- **Value**: ISO timestamp
- **TTL**: 15 minutes (auto-release if worker crashes)

### 4. Notification Queue
- **Key**: `queue:notify:{timestamp}:{urlHash}`
- **Value**: `{opportunity, summarized, attempts, lastAttempt?, error?}`
- **TTL**: 7 days

### 5. Dead Letter Queue (permanently failed items)
- **Key**: `dlq:summarize:{urlHash}` or `dlq:notify:{urlHash}`
- **Value**: `{job, failedAt, attempts, lastError, module}`
- **TTL**: 30 days

## Cron Schedules

```toml
[triggers]
crons = [
  "0 */2 * * *",    # Crawler: Every 2 hours
  "*/15 * * * *",   # Summarizer: Every 15 minutes
  "*/5 * * * *"     # Notifier: Every 5 minutes
]
```

**Rationale**:
- Crawler at 2h: Matches current frequency, EU portal update rate
- Summarizer at 15min: Balances latency vs AI cost, processes ~5 items/run
- Notifier at 5min: Fast delivery, cheap operation, ~10 items/run

## Module Flows

### Crawler Module (every 2 hours)
1. Fetch EU portal HTML (Puppeteer or fetch)
2. Parse opportunities using existing `parseOpportunities()`
3. For each opportunity:
   - Hash URL, check `seen:{hash}` in KV
   - If unseen: enqueue to `queue:summarize:*` and mark as seen
   - If seen: skip
4. Log metrics

### Summarizer Module (every 15 minutes)
1. List pending jobs from `queue:summarize:*` (limit: 5)
2. For each job:
   - Attempt to claim via `processing:{hash}` (TTL: 15min)
   - If already claimed: skip
   - Check summary cache (existing KV by URL)
   - If not cached: call `summarizeLink()` (reuse existing code)
   - If successful: enqueue to `queue:notify:*`, cache summary, complete job
   - If failed: increment attempts, store error
   - If attempts > 3: move to DLQ, remove from queue
3. Log metrics

### Notifier Module (every 5 minutes)
1. List pending jobs from `queue:notify:*` (limit: 10)
2. For each job:
   - Attempt to claim via `processing:{hash}`
   - If already claimed: skip
   - Format Discord embed (rich message with fields)
   - POST to Discord webhook
   - If success: complete job, remove from queue
   - If rate limit (429): release claim, retry on next run
   - If other error: increment attempts
   - If attempts > 5: move to DLQ
3. Log metrics

## Discord Message Format

Rich embed with:
- **Title**: Opportunity title (linked)
- **Description**: AI-generated summary
- **Color**: Status-based (green=Open, blue=Forthcoming, etc.)
- **Fields**: Identifier, Status, Type, Opening Date, Deadline, Stage, Programme, Action Type
- **Footer**: "EU Fund Tracker • Powered by Cloudflare Workers"

Rate limiting:
- Discord limit: 30 req/min per webhook
- Our rate: 10 notifications per 5min = 2 req/min (safe)
- Handle 429 responses with retry_after

## Implementation Order

### Phase 1: Core Infrastructure (files 1-2)
1. **src/shared/dedup.ts** - Simple, no dependencies
   - `hashUrl(url: string): string` - MD5 hash
   - `isSeen(kv, url): Promise<boolean>` - Check KV
   - `markSeen(kv, url, metadata): Promise<void>` - Write KV

2. **src/shared/queue.ts** - Core queue operations
   - `enqueue(kv, prefix, key, value, ttl)`
   - `listPending(kv, prefix, limit): Promise<string[]>` - List queue keys
   - `claim(kv, key, ttl): Promise<boolean>` - Try to claim
   - `release(kv, key): Promise<void>` - Release claim
   - `complete(kv, queueKey, processingKey): Promise<void>` - Remove both
   - `fail(kv, queueKey, error, maxAttempts): Promise<void>` - Increment or DLQ

### Phase 2: Discord Integration (file 3)
3. **src/shared/discord.ts** - Discord webhook client
   - `createEmbed(opportunity): DiscordEmbed` - Format message
   - `postToWebhook(webhookUrl, embed): Promise<void>` - POST with error handling
   - Status color mapping

### Phase 3: Modules (files 4-6)
4. **src/modules/crawler.ts** - First module
   - Reuse `fetchListingHtml()` and `parseOpportunities()` from existing code
   - Integrate dedup + queue

5. **src/modules/summarizer.ts** - Second module
   - Poll queue, claim jobs
   - Reuse `summarizeLink()` from existing code
   - Retry logic with attempts tracking

6. **src/modules/notifier.ts** - Third module
   - Poll queue, claim jobs
   - Call Discord webhook
   - Rate limit handling

### Phase 4: Integration (files 7-9)
7. **src/types.ts** - Add new interfaces
   - `SeenRecord`, `SummarizeJob`, `NotifyJob`, `DiscordEmbed`
   - Update `Env` with Discord webhook URL

8. **src/index.ts** - Update main entry point
   - Route scheduled events to appropriate module
   - Remove RSS fetch handler
   - Add feature flag support (optional)

9. **wrangler.toml** - Update configuration
   - Add 3 cron schedules
   - Add env vars section
   - Document DISCORD_WEBHOOK_URL secret

### Phase 5: Cleanup (file 10)
10. **src/parsePage.ts** - Remove RSS generation
    - Delete `itemsToRssXml()` function
    - Keep `parseOpportunities()` unchanged

## Environment Variables

Add to wrangler.toml:
```toml
[vars]
CRAWLER_BATCH_SIZE = "50"
SUMMARIZER_BATCH_SIZE = "5"
NOTIFIER_BATCH_SIZE = "10"
MAX_SUMMARIZE_ATTEMPTS = "3"
MAX_NOTIFY_ATTEMPTS = "5"
```

Secret (set via CLI):
```bash
wrangler secret put DISCORD_WEBHOOK_URL
```

## Error Handling

**Retry Strategies**:
- **Summarizer**: Max 3 attempts, then DLQ (failures often permanent - 404, bad data)
- **Notifier**: Max 5 attempts, then DLQ (failures often transient - rate limit, network)

**Claim Timeout**:
- 15 minute TTL on processing claims
- Auto-releases if worker crashes
- Prevents jobs getting stuck

**DLQ Pattern**:
- Store permanently failed items for debugging
- 30 day TTL for analysis
- Separate keys for summarizer vs notifier failures

## Testing Strategy

**Manual Testing Flow**:
1. Deploy with test webhook URL
2. Manually trigger crawler cron
3. Verify KV has `queue:summarize:*` keys
4. Manually trigger summarizer cron
5. Verify KV has `queue:notify:*` keys
6. Manually trigger notifier cron
7. Verify Discord message received
8. Run crawler again, verify dedup works (no duplicate queue entries)

**Unit Tests** (expand existing test suite):
- `test/shared/queue.spec.ts` - Queue operations
- `test/shared/dedup.spec.ts` - Deduplication logic
- `test/shared/discord.spec.ts` - Embed formatting
- `test/modules/crawler.spec.ts` - Crawler integration
- `test/modules/summarizer.spec.ts` - Summarizer integration
- `test/modules/notifier.spec.ts` - Notifier integration

## Migration Plan

**Safe Rollout**:
1. Deploy new code WITHOUT removing RSS
2. Add new crons alongside existing snapshot cron
3. Both systems run in parallel for 1 week
4. Monitor Discord notifications vs RSS content
5. If stable, remove RSS code
6. If issues, can revert by disabling new crons

**No Data Migration Needed**:
- Existing summary cache (by URL) is reused
- No breaking changes to KV structure
- Start fresh with empty queues

## Monitoring

**Key Metrics**:
- Queue depths: Check `queue:summarize:*` and `queue:notify:*` key counts
- DLQ size: Alert if > 20 items
- Processing claims: Should be < 5 typically
- Success/failure rates in logs

**Warning Signs**:
- Summarize queue > 100 (backlog building)
- Notify queue > 50 (Discord posting failing)
- DLQ growing rapidly (systematic failures)
- Processing claims > 10 (claims not releasing)

## Critical Files to Modify

1. `src/shared/dedup.ts` - NEW
2. `src/shared/queue.ts` - NEW
3. `src/shared/discord.ts` - NEW
4. `src/modules/crawler.ts` - NEW
5. `src/modules/summarizer.ts` - NEW
6. `src/modules/notifier.ts` - NEW
7. `src/types.ts` - UPDATE
8. `src/index.ts` - UPDATE
9. `wrangler.toml` - UPDATE
10. `src/parsePage.ts` - UPDATE (remove RSS)

## Success Criteria

- [ ] Crawler discovers new opportunities
- [ ] Deduplication prevents reprocessing
- [ ] Summaries generated via AI
- [ ] Discord notifications received
- [ ] No timeout errors
- [ ] Queue depths remain healthy
- [ ] Failed items move to DLQ appropriately
- [ ] Can run for 1 week without issues
