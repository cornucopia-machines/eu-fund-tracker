import { handleCrawlerCron } from './modules/crawler';
import { handleSummarizerCron } from './modules/summarizer';
import { handleNotifierCron } from './modules/notifier';
import type { Env } from './types';

/**
 * Main worker entry point.
 * Routes scheduled cron events to appropriate modules.
 */
export default {
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		const cron = controller.cron;
		console.log(`Scheduled event triggered: ${cron}`);

		try {
			// Route to appropriate module based on cron schedule
			// Crawler: "0 */2 * * *" (every 2 hours)
			// Summarizer: "*/15 * * * *" (every 15 minutes)
			// Notifier: "*/5 * * * *" (every 5 minutes)

			if (cron === '0 */2 * * *') {
				await handleCrawlerCron(env);
			} else if (cron === '*/15 * * * *') {
				await handleSummarizerCron(env);
			} else if (cron === '*/5 * * * *') {
				await handleNotifierCron(env);
			} else {
				console.warn(`Unknown cron schedule: ${cron}`);
			}
		} catch (error: any) {
			console.error('Scheduled event failed:', error?.message || error);
			// Don't throw - let Worker complete and retry on next cron
		}
	},

	async fetch(req: Request, env: Env): Promise<Response> {
		// Health check endpoint
		return new Response(
			JSON.stringify({
				status: 'ok',
				service: 'EU Fund Tracker',
				mode: 'Discord Push Notifications',
				timestamp: new Date().toISOString(),
			}),
			{
				headers: { 'Content-Type': 'application/json' },
			}
		);
	},
};
