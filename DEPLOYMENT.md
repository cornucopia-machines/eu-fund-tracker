# Deployment Guide

## Architecture Overview

The EU Fund Tracker is split into **3 independent Cloudflare Workers**:

1. **Crawler Worker** (`eu-fund-tracker-crawler`)

   - Runs every 2 hours
   - Discovers new opportunities
   - Entry point: `src/workers/crawler.ts`
   - Config: `wrangler.crawler.toml`

2. **Summarizer Worker** (`eu-fund-tracker-summarizer`)

   - Runs every 15 minutes
   - Generates AI summaries
   - Entry point: `src/workers/summarizer.ts`
   - Config: `wrangler.summarizer.toml`

3. **Notifier Worker** (`eu-fund-tracker-notifier`)
   - Runs every 5 minutes
   - Posts to Discord
   - Entry point: `src/workers/notifier.ts`
   - Config: `wrangler.notifier.toml`

## Prerequisites

1. **Cloudflare account** with Workers enabled
2. **Discord webhook URL** for notifications
3. **Wrangler CLI** authenticated (`wrangler login`)

## Initial Setup

### 1. Set Discord Webhook Secret

```bash
wrangler secret put DISCORD_WEBHOOK_URL --config wrangler.notifier.toml
```

When prompted, paste your Discord webhook URL.

### 2. Verify KV Namespace ID

Check that the KV namespace ID in all wrangler configs matches your Cloudflare KV namespace:

```toml
[[kv_namespaces]]
binding = "SUMMARIES"
id = "36f31f2cacf14962a24cb0acb8f19778"  # Should match your KV namespace
```

If you need to create a new KV namespace:

```bash
wrangler kv:namespace create "SUMMARIES"
```

Then update the `id` in all three wrangler.\*.toml files.

## Deployment

### Deploy All Workers

```bash
npm run deploy
```

This deploys all three workers in sequence.

### Deploy Individual Workers

```bash
# Deploy just the crawler
npm run deploy:crawler

# Deploy just the summarizer
npm run deploy:summarizer

# Deploy just the notifier
npm run deploy:notifier
```

## Verification

After deployment, verify each worker:

### 1. Check Workers Dashboard

Visit: https://dash.cloudflare.com/?to=/:account/workers-and-pages

You should see:

- `eu-fund-tracker-crawler`
- `eu-fund-tracker-summarizer`
- `eu-fund-tracker-notifier`

### 2. Trigger Crawler Manually (Optional)

```bash
wrangler dev --config wrangler.crawler.toml --test-scheduled
```

Or wait for the next 2-hour mark (00:00, 02:00, 04:00, etc.)

### 3. Monitor Logs

```bash
# View crawler logs
wrangler tail --config wrangler.crawler.toml

# View summarizer logs
wrangler tail --config wrangler.summarizer.toml

# View notifier logs
wrangler tail --config wrangler.notifier.toml
```

### 4. Check KV Queue Status

Visit your KV namespace in the Cloudflare dashboard and look for:

- Keys with prefix `queue:summarize:` (should be 0-50 typically)
- Keys with prefix `queue:notify:` (should be 0-10 typically)
- Keys with prefix `seen:` (grows over time)

If queues are growing unbounded, check logs for errors.

### 5. Verify Discord Messages

Wait for the first complete cycle:

1. Crawler runs (every 2 hours)
2. Summarizer processes queue (within ~15 minutes)
3. Notifier posts to Discord (within ~5 minutes)

Total time from discovery to Discord: ~20 minutes max

## Development

### Local Development

```bash
# Test crawler locally
npm run dev:crawler

# Test summarizer locally
npm run dev:summarizer

# Test notifier locally
npm run dev:notifier
```

Note: Local dev may require authentication for remote mode.

### Testing Changes Before Deploy

```bash
# Run tests
npm test

# Type check
npx tsc --noEmit
```

## Monitoring

### Key Metrics to Watch

1. **Queue Depths** (via KV dashboard):

   - `queue:summarize:*` - Should stay under 100
   - `queue:notify:*` - Should stay under 50
   - Growing queues indicate backlog

2. **Dead Letter Queue** (via KV dashboard):

   - `dlq:summarize:*` - Failed summarizations
   - `dlq:notify:*` - Failed notifications
   - Investigate if DLQ size > 20

3. **Processing Claims** (via KV dashboard):

   - `processing:*` - Should be 0-5 typically
   - High count may indicate stuck jobs (auto-expire after 15min)

4. **Worker Execution** (via Cloudflare dashboard):
   - CPU time
   - Error rates
   - Success rates

### Common Issues

**Queue backing up:**

- Check logs for errors in summarizer/notifier
- Increase batch sizes if needed
- Check AI quota if summarizer is slow

**Discord not receiving messages:**

- Verify `DISCORD_WEBHOOK_URL` secret is set correctly
- Check notifier logs for 429 (rate limit) or 400 (bad request)
- Test webhook URL manually with curl

**No new opportunities:**

- Check crawler logs
- Verify EU portal is accessible
- Check if `seen:*` keys are accumulating (dedup working)

## Rollback

To rollback to a previous version:

```bash
# Deploy specific version
wrangler deploy --config wrangler.crawler.toml --rollback-to <version>
```

Or redeploy from a previous git commit:

```bash
git checkout <previous-commit>
npm run deploy
git checkout main
```

## Cleanup

To completely remove the workers:

```bash
wrangler delete --config wrangler.crawler.toml
wrangler delete --config wrangler.summarizer.toml
wrangler delete --config wrangler.notifier.toml
```

To clear queues (careful!):

```bash
# This will delete all queue data
# Use Cloudflare dashboard to bulk delete keys with prefix:
# - queue:summarize:
# - queue:notify:
# - processing:
```
