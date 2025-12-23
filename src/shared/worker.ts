import type { Env } from '../types';

export interface WorkerConfig {
	name: string;
	description?: string;
}

export interface WorkerHandler<E extends Env = Env> {
	(env: E): Promise<void>;
}

/**
 * Creates a Cloudflare Worker with both scheduled and manual trigger support.
 *
 * Manual triggers can be invoked via GET request to /run-once
 *
 * @param config Worker configuration (name, description)
 * @param handler The main worker logic to execute
 * @returns ExportedHandler for Cloudflare Workers
 */
export function createWorker<E extends Env = Env>(
	config: WorkerConfig,
	handler: WorkerHandler<E>
) {
	return {
		async scheduled(controller: ScheduledController, env: E, ctx: ExecutionContext) {
			console.log(`[${config.name}] Scheduled event triggered`);

			try {
				await handler(env);
				console.log(`[${config.name}] Completed successfully`);
			} catch (error: any) {
				console.error(`[${config.name}] Failed:`, error?.message || error);
				// Don't throw - let worker complete and retry on next cron
			}
		},

		async fetch(req: Request, env: E): Promise<Response> {
			const url = new URL(req.url);
			const shouldTrigger = url.pathname === '/run-once';

			if (shouldTrigger) {
				console.log(`[${config.name}] Manual trigger requested`);

				try {
					await handler(env);

					return new Response(
						JSON.stringify({
							worker: config.name,
							status: 'success',
							message: 'Worker executed successfully',
							timestamp: new Date().toISOString(),
						}),
						{
							status: 200,
							headers: { 'Content-Type': 'application/json' },
						}
					);
				} catch (error: any) {
					console.error(`[${config.name}] Manual trigger failed:`, error?.message || error);

					return new Response(
						JSON.stringify({
							worker: config.name,
							status: 'error',
							message: error?.message || String(error),
							timestamp: new Date().toISOString(),
						}),
						{
							status: 500,
							headers: { 'Content-Type': 'application/json' },
						}
					);
				}
			}

			// Default health check response
			return new Response(
				JSON.stringify({
					worker: config.name,
					status: 'ok',
					description: config.description,
					timestamp: new Date().toISOString(),
					trigger: 'Send a GET request to /run-once to manually run this worker',
				}),
				{
					headers: { 'Content-Type': 'application/json' },
				}
			);
		},
	};
}
