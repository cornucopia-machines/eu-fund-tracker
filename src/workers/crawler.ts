import { handleCrawlerCron } from '../modules/crawler';
import type { Env } from '../types';

/**
 * Crawler worker - discovers new EU funding opportunities.
 * Runs every 2 hours.
 */
export default {
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		console.log('[Crawler Worker] Scheduled event triggered');
		await handleCrawlerCron(env);
	},

	async fetch(req: Request, env: Env): Promise<Response> {
		return new Response(
			JSON.stringify({
				worker: 'crawler',
				status: 'ok',
				schedule: 'Every 2 hours',
				timestamp: new Date().toISOString(),
			}),
			{
				headers: { 'Content-Type': 'application/json' },
			}
		);
	},
};
