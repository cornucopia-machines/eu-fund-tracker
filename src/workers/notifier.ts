import { handleNotifierCron } from '../modules/notifier';
import type { Env } from '../types';

/**
 * Notifier worker - posts summarized opportunities to Discord.
 * Runs every 5 minutes.
 */
export default {
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		console.log('[Notifier Worker] Scheduled event triggered');
		await handleNotifierCron(env);
	},

	async fetch(req: Request, env: Env): Promise<Response> {
		return new Response(
			JSON.stringify({
				worker: 'notifier',
				status: 'ok',
				schedule: 'Every 5 minutes',
				timestamp: new Date().toISOString(),
			}),
			{
				headers: { 'Content-Type': 'application/json' },
			}
		);
	},
};
