import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Worker health check', () => {
	it('returns OK for health check', async () => {
		const request = new IncomingRequest('http://example.com/');
		const ctx = createExecutionContext(); // retained in case worker adds waitUntil usage later
		const response = await worker.fetch(request, env);
		await waitOnExecutionContext(ctx); // does nothing currently
		const body = await response.text();
		expect(response.headers.get('Content-Type')).toContain('application/json');
    const json = JSON.parse(body);
    expect(json.status).toBe('ok');
	});
});
