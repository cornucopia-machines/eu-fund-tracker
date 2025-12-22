import { summarizeLink } from '../summarize';
import { postOpportunity } from '../shared/discord';
import {
	listPending,
	claim,
	release,
	complete,
	fail,
	SUMMARIZE_QUEUE_PREFIX,
	DLQ_SUMMARIZE_PREFIX,
	getJob,
} from '../shared/queue';
import type { Env, SummarizeJob } from '../types';
import { Duration } from 'luxon';

/**
 * Processor worker - handles both summarization and notification.
 * Runs every 15 minutes.
 *
 * Flow:
 * For each opportunity in the queue:
 * 1. Generate AI summary (or use cached)
 * 2. Post to Discord immediately
 * 3. Complete the job
 */
async function handleProcessorCron(env: Env): Promise<void> {
	console.log('[Processor] Starting processing');
	const startTime = Date.now();

	if (!env.SUMMARIES) {
		throw new Error('No SUMMARIES KV namespace binding');
	}

	if (!env.DISCORD_WEBHOOK_URL) {
		throw new Error('No DISCORD_WEBHOOK_URL environment variable');
	}

	const batchSize = parseInt(env.SUMMARIZER_BATCH_SIZE || '5', 10);
	const maxAttempts = parseInt(env.MAX_SUMMARIZE_ATTEMPTS || '3', 10);

	let processed = 0;
	let succeeded = 0;
	let failed = 0;
	let skipped = 0;

	try {
		// Get pending jobs from summarization queue
		const pendingKeys = await listPending(env.SUMMARIES, SUMMARIZE_QUEUE_PREFIX, batchSize);

		console.log(`[Processor] Found ${pendingKeys.length} pending jobs (limit: ${batchSize})`);

		for (const queueKey of pendingKeys) {
			const job = await getJob<SummarizeJob>(env.SUMMARIES, queueKey);

			if (!job) {
				console.warn(`[Processor] Job disappeared: ${queueKey}`);
				continue;
			}

			const url = job.url;
			processed++;

			// Try to claim this job
			const claimed = await claim(env.SUMMARIES, url);

			if (!claimed) {
				console.log(`[Processor] Job already claimed: ${job.opportunity.identifier || url}`);
				skipped++;
				continue;
			}

			try {
				// Step 1: Generate or retrieve cached summary
				let summary = await env.SUMMARIES.get(url);

				if (!summary) {
					console.log(`[Processor] Generating summary for: ${job.opportunity.identifier || job.opportunity.title}`);

					const generatedSummary = await summarizeLink(url, {
						env,
						modelOverride: env.SUMMARY_MODEL,
					});

					if (!generatedSummary) {
						throw new Error('Failed to generate summary (null/undefined returned)');
					}

					summary = generatedSummary;

					// Cache the summary
					await env.SUMMARIES.put(url, summary, {
						expirationTtl: Duration.fromObject({ weeks: 2 }).as('seconds'),
					});
				} else {
					console.log(`[Processor] Using cached summary for: ${job.opportunity.identifier || job.opportunity.title}`);
				}

				// Add summary to opportunity
				job.opportunity.summary = summary;

				// Step 2: Post to Discord immediately
				console.log(`[Processor] Posting to Discord: ${job.opportunity.identifier || job.opportunity.title}`);
				await postOpportunity(env.DISCORD_WEBHOOK_URL, job.opportunity);

				// Step 3: Mark job as complete
				await complete(env.SUMMARIES, queueKey, url);

				succeeded++;
				console.log(`[Processor] Successfully processed: ${job.opportunity.identifier || job.opportunity.title}`);

				// Small delay to avoid bursting Discord rate limits
				await new Promise((resolve) => setTimeout(resolve, 200));
			} catch (error: any) {
				const errorMsg = error?.message || String(error);

				// Check if it's a rate limit error from Discord
				if (errorMsg.includes('rate limit')) {
					console.warn(`[Processor] Rate limited, releasing claim for retry: ${job.opportunity.identifier}`);
					// Release the claim so it can be retried on next run
					await release(env.SUMMARIES, url);
					skipped++;
				} else {
					// Other error - handle with retry/DLQ logic
					failed++;
					console.error(`[Processor] Error processing ${job.opportunity.identifier}:`, error);
					await fail(env.SUMMARIES, queueKey, url, errorMsg, maxAttempts, DLQ_SUMMARIZE_PREFIX);
				}
			}
		}

		const duration = Date.now() - startTime;
		console.log(
			`[Processor] Complete in ${duration}ms - Processed: ${processed}, Succeeded: ${succeeded}, Failed: ${failed}, Skipped: ${skipped}`
		);
	} catch (error: any) {
		console.error('[Processor] Processing failed:', error?.message || error);
		throw error;
	}
}

export default {
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		console.log('[Processor Worker] Scheduled event triggered');

		try {
			await handleProcessorCron(env);
			console.log('[Processor Worker] Completed successfully');
		} catch (error: any) {
			console.error('[Processor Worker] Failed:', error?.message || error);
			// Don't throw - let worker complete and retry on next cron
		}
	},

	async fetch(req: Request, env: Env): Promise<Response> {
		return new Response(
			JSON.stringify({
				worker: 'processor',
				status: 'ok',
				flow: 'Summarize and notify each entry sequentially',
				schedule: 'Every 15 minutes',
				timestamp: new Date().toISOString(),
			}),
			{
				headers: { 'Content-Type': 'application/json' },
			}
		);
	},
};
