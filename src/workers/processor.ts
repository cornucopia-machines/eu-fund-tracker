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
import { createWorker } from '../shared/worker';
import type { Env, SummarizeBatchJob } from '../types';
import { Duration } from 'luxon';
import { createPageWithBrowserIfNeeded } from '../shared/browser';

/**
 * Processor worker - handles both summarization and notification.
 *
 * Flow:
 * 1. Pick up a single batch from the queue (contains up to 10 opportunities)
 * 2. For each opportunity in the batch:
 *    - Generate AI summary (or use cached)
 *    - Post to Discord immediately
 * 3. Complete the batch job
 */
async function runOnce(env: Env): Promise<void> {
	console.log('[Processor] Starting processing');
	const startTime = Date.now();

	if (!env.SUMMARIES) {
		throw new Error('No SUMMARIES KV namespace binding');
	}

	if (!env.DISCORD_WEBHOOK_URL) {
		throw new Error('No DISCORD_WEBHOOK_URL environment variable');
	}

	const maxAttempts = parseInt(env.MAX_SUMMARIZE_ATTEMPTS || '3', 10);

	let processed = 0;
	let succeeded = 0;
	let failed = 0;
	let skipped = 0;

	const { page, browser } = await createPageWithBrowserIfNeeded(env);

	try {
		// Get one batch from summarization queue
		const pendingKeys = await listPending(env.SUMMARIES, SUMMARIZE_QUEUE_PREFIX, 1);

		if (pendingKeys.length === 0) {
			console.log('[Processor] No pending batches in queue');
			return;
		}

		const queueKey = pendingKeys[0];
		const batchJob = await getJob<SummarizeBatchJob>(env.SUMMARIES, queueKey);

		if (!batchJob) {
			console.warn(`[Processor] Batch job disappeared: ${queueKey}`);
			return;
		}

		console.log(`[Processor] Retrieved job from queue:`, JSON.stringify(batchJob, null, 2));

		// Validate job structure
		if (!batchJob.batchId) {
			console.error(`[Processor] Invalid job structure - missing batchId. Job data:`, batchJob);
			throw new Error(`Invalid job structure in queue key ${queueKey} - this might be an old-format job. Please clear the queue.`);
		}

		if (!Array.isArray(batchJob.opportunities)) {
			console.error(`[Processor] Invalid job structure - opportunities is not an array. Job data:`, batchJob);
			throw new Error(`Invalid job structure in queue key ${queueKey} - opportunities field is not an array`);
		}

		console.log(`[Processor] Processing batch ${batchJob.batchId} with ${batchJob.opportunities.length} opportunities`);

		// Try to claim this batch
		const claimed = await claim(env.SUMMARIES, batchJob.batchId);

		if (!claimed) {
			console.log(`[Processor] Batch already claimed: ${batchJob.batchId}`);
			return;
		}

		let batchHasError = false;
		let batchErrorMsg = '';

		// Process each opportunity in the batch
		for (const opportunity of batchJob.opportunities) {
			const url = opportunity.link;
			processed++;

			try {
				// Step 1: Generate or retrieve cached summary
				let summary = await env.SUMMARIES.get(url);

				if (!summary) {
					console.log(`[Processor] Generating summary for: ${opportunity.identifier || opportunity.title} at '${url}'`);

					const generatedSummary = await summarizeLink(url, {
						env,
						modelOverride: env.SUMMARY_MODEL,
						browserPage: page,
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
					console.log(`[Processor] Using cached summary for: ${opportunity.identifier || opportunity.title}`);
				}

				// Add summary to opportunity
				opportunity.summary = summary;

				// Step 2: Post to Discord immediately
				console.log(`[Processor] Posting to Discord: ${opportunity.identifier || opportunity.title}`);
				await postOpportunity(env.DISCORD_WEBHOOK_URL, opportunity);

				succeeded++;
				console.log(`[Processor] Successfully processed: ${opportunity.identifier || opportunity.title}`);

				// Small delay to avoid bursting Discord rate limits
				await new Promise((resolve) => setTimeout(resolve, 200));
			} catch (error: any) {
				const errorMsg = error?.message || String(error);

				// Check if it's a rate limit error from Discord
				if (errorMsg.includes('rate limit')) {
					console.warn(`[Processor] Rate limited, releasing batch claim for retry: ${opportunity.identifier}`);
					// Release the claim so the entire batch can be retried on next run
					await release(env.SUMMARIES, batchJob.batchId);
					skipped += batchJob.opportunities.length - processed + 1;
					const duration = Date.now() - startTime;
					console.log(
						`[Processor] Complete in ${duration}ms - Processed: ${processed}, Succeeded: ${succeeded}, Failed: ${failed}, Skipped: ${skipped}`
					);
					return;
				} else {
					// Other error - mark batch for retry/DLQ
					failed++;
					batchHasError = true;
					batchErrorMsg = errorMsg;
					console.error(`[Processor] Error processing ${opportunity.identifier}:`, error);
				}
			}
		}

		// Step 3: Complete or fail the batch job
		if (batchHasError) {
			await fail(env.SUMMARIES, queueKey, batchJob.batchId, batchErrorMsg, maxAttempts, DLQ_SUMMARIZE_PREFIX);
		} else {
			await complete(env.SUMMARIES, queueKey, batchJob.batchId);
			console.log(`[Processor] Batch ${batchJob.batchId} completed successfully`);
		}

		const duration = Date.now() - startTime;
		console.log(
			`[Processor] Complete in ${duration}ms - Processed: ${processed}, Succeeded: ${succeeded}, Failed: ${failed}, Skipped: ${skipped}`
		);
	} catch (error: any) {
		console.error('[Processor] Processing failed:', error);
		if (error?.stack) {
			console.error('[Processor] Stack trace:', error.stack);
		}
		throw error;
	} finally {
		browser?.close();
	}
}

/**
 * Processor worker - handles both summarization and notification.
 */
export default createWorker(
	{
		name: 'Processor',
		description: 'Summarizes opportunities and posts them to Discord',
	},
	runOnce
);
