import { handleSummarizerCron } from '../modules/summarizer';
import { handleNotifierCron } from '../modules/notifier';
import type { Env } from '../types';

/**
 * Processor worker - handles both summarization and notification.
 * Runs every 15 minutes.
 *
 * Flow:
 * 1. Process summarization queue (generate AI summaries)
 * 2. Process notification queue (post to Discord)
 */
export default {
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		console.log('[Processor Worker] Scheduled event triggered');

		try {
			// Step 1: Summarize opportunities (polls queue, generates AI summaries)
			console.log('[Processor Worker] Running summarizer...');
			await handleSummarizerCron(env);

			// Step 2: Notify via Discord (polls notification queue, posts to webhook)
			console.log('[Processor Worker] Running notifier...');
			await handleNotifierCron(env);

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
				modules: ['summarizer', 'notifier'],
				schedule: 'Every 15 minutes',
				timestamp: new Date().toISOString(),
			}),
			{
				headers: { 'Content-Type': 'application/json' },
			}
		);
	},
};
