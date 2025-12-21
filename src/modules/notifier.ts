import { postOpportunity } from '../shared/discord';
import {
	listPending,
	claim,
	release,
	complete,
	fail,
	NOTIFY_QUEUE_PREFIX,
	DLQ_NOTIFY_PREFIX,
	getJob,
} from '../shared/queue';
import type { Env, NotifyJob } from '../types';

/**
 * Notifier module: Posts summarized opportunities to Discord webhook.
 * Runs on cron schedule (every 5 minutes).
 */
export async function handleNotifierCron(env: Env): Promise<void> {
	console.log('[Notifier] Starting processing');
	const startTime = Date.now();

	if (!env.SUMMARIES) {
		throw new Error('No SUMMARIES KV namespace binding');
	}

	if (!env.DISCORD_WEBHOOK_URL) {
		throw new Error('No DISCORD_WEBHOOK_URL environment variable');
	}

	const batchSize = parseInt(env.NOTIFIER_BATCH_SIZE || '10', 10);
	const maxAttempts = parseInt(env.MAX_NOTIFY_ATTEMPTS || '5', 10);

	let processed = 0;
	let succeeded = 0;
	let failed = 0;
	let skipped = 0;

	try {
		// Get pending jobs from queue
		const pendingKeys = await listPending(env.SUMMARIES, NOTIFY_QUEUE_PREFIX, batchSize);

		console.log(`[Notifier] Found ${pendingKeys.length} pending notifications (limit: ${batchSize})`);

		for (const queueKey of pendingKeys) {
			const job = await getJob<NotifyJob>(env.SUMMARIES, queueKey);

			if (!job) {
				console.warn(`[Notifier] Job disappeared: ${queueKey}`);
				continue;
			}

			const url = job.opportunity.link;
			processed++;

			// Try to claim this job
			const claimed = await claim(env.SUMMARIES, url);

			if (!claimed) {
				console.log(`[Notifier] Job already claimed: ${job.opportunity.identifier || url}`);
				skipped++;
				continue;
			}

			try {
				// Post to Discord
				console.log(`[Notifier] Posting to Discord: ${job.opportunity.identifier || job.opportunity.title}`);

				await postOpportunity(env.DISCORD_WEBHOOK_URL, job.opportunity);

				// Mark job as complete
				await complete(env.SUMMARIES, queueKey, url);

				succeeded++;
				console.log(`[Notifier] Successfully posted: ${job.opportunity.identifier || job.opportunity.title}`);

				// Small delay to avoid bursting Discord rate limits
				await new Promise((resolve) => setTimeout(resolve, 200));
			} catch (error: any) {
				const errorMsg = error?.message || String(error);

				// Check if it's a rate limit error
				if (errorMsg.includes('rate limit')) {
					console.warn(`[Notifier] Rate limited, releasing claim for retry: ${job.opportunity.identifier}`);
					// Release the claim so it can be retried on next run
					await release(env.SUMMARIES, url);
					skipped++;
				} else {
					// Other error - handle with retry/DLQ logic
					failed++;
					console.error(`[Notifier] Error posting ${job.opportunity.identifier}:`, errorMsg);
					await fail(env.SUMMARIES, queueKey, url, errorMsg, maxAttempts, DLQ_NOTIFY_PREFIX);
				}
			}
		}

		const duration = Date.now() - startTime;
		console.log(
			`[Notifier] Complete in ${duration}ms - Processed: ${processed}, Succeeded: ${succeeded}, Failed: ${failed}, Skipped: ${skipped}`
		);
	} catch (error: any) {
		console.error('[Notifier] Module failed:', error?.message || error);
		throw error;
	}
}
