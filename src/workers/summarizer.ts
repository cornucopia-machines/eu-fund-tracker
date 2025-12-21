import { handleSummarizerCron } from '../modules/summarizer';
import type { Env } from '../types';

/**
 * Summarizer worker - generates AI summaries for queued opportunities.
 * Runs every 15 minutes.
 */
export default {
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		console.log('[Summarizer Worker] Scheduled event triggered');
		await handleSummarizerCron(env);
	},

	async fetch(req: Request, env: Env): Promise<Response> {
		return new Response(
			JSON.stringify({
				worker: 'summarizer',
				status: 'ok',
				schedule: 'Every 15 minutes',
				timestamp: new Date().toISOString(),
			}),
			{
				headers: { 'Content-Type': 'application/json' },
			}
		);
	},
};
