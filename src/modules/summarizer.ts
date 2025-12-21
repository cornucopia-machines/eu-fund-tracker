import { summarizeLink } from '../summarize';
import { listPending, claim, release, complete, fail, SUMMARIZE_QUEUE_PREFIX, NOTIFY_QUEUE_PREFIX, DLQ_SUMMARIZE_PREFIX, getJob } from '../shared/queue';
import { enqueue } from '../shared/queue';
import type { Env, SummarizeJob, NotifyJob } from '../types';
import { Duration } from 'luxon';

/**
 * Summarizer module: Processes queued opportunities and generates AI summaries.
 * Runs on cron schedule (every 15 minutes).
 */
export async function handleSummarizerCron(env: Env): Promise<void> {
	console.log('[Summarizer] Starting processing');
	const startTime = Date.now();

	if (!env.SUMMARIES) {
		throw new Error('No SUMMARIES KV namespace binding');
	}

	const batchSize = parseInt(env.SUMMARIZER_BATCH_SIZE || '5', 10);
	const maxAttempts = parseInt(env.MAX_SUMMARIZE_ATTEMPTS || '3', 10);

	let processed = 0;
	let succeeded = 0;
	let failed = 0;
	let skipped = 0;

	try {
		// Get pending jobs from queue
		const pendingKeys = await listPending(env.SUMMARIES, SUMMARIZE_QUEUE_PREFIX, batchSize);

		console.log(`[Summarizer] Found ${pendingKeys.length} pending jobs (limit: ${batchSize})`);

		for (const queueKey of pendingKeys) {
			const job = await getJob<SummarizeJob>(env.SUMMARIES, queueKey);

			if (!job) {
				console.warn(`[Summarizer] Job disappeared: ${queueKey}`);
				continue;
			}

			const url = job.url;
			processed++;

			// Try to claim this job
			const claimed = await claim(env.SUMMARIES, url);

			if (!claimed) {
				console.log(`[Summarizer] Job already claimed: ${job.opportunity.identifier || url}`);
				skipped++;
				continue;
			}

			try {
				// Check if summary already cached
				let summary = await env.SUMMARIES.get(url);

				if (!summary) {
					// Generate new summary
					console.log(`[Summarizer] Generating summary for: ${job.opportunity.identifier || job.opportunity.title}`);

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
					console.log(`[Summarizer] Using cached summary for: ${job.opportunity.identifier || job.opportunity.title}`);
				}

				// Add summary to opportunity
				job.opportunity.summary = summary;

				// Enqueue for notification
				const notifyJob: NotifyJob = {
					opportunity: job.opportunity,
					summarized: new Date().toISOString(),
					attempts: 0,
				};

				await enqueue(env.SUMMARIES, NOTIFY_QUEUE_PREFIX, url, notifyJob);

				// Mark job as complete
				await complete(env.SUMMARIES, queueKey, url);

				succeeded++;
				console.log(`[Summarizer] Successfully processed: ${job.opportunity.identifier || job.opportunity.title}`);
			} catch (error: any) {
				failed++;
				const errorMsg = error?.message || String(error);
				console.error(`[Summarizer] Error processing ${job.opportunity.identifier}:`, errorMsg);

				// Handle failure (retry or move to DLQ)
				await fail(env.SUMMARIES, queueKey, url, errorMsg, maxAttempts, DLQ_SUMMARIZE_PREFIX);
			}
		}

		const duration = Date.now() - startTime;
		console.log(
			`[Summarizer] Complete in ${duration}ms - Processed: ${processed}, Succeeded: ${succeeded}, Failed: ${failed}, Skipped: ${skipped}`
		);
	} catch (error: any) {
		console.error('[Summarizer] Module failed:', error?.message || error);
		throw error;
	}
}
