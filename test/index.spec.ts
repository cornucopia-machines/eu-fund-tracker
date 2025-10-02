import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Worker RSS (no-browser path)', () => {
  it('parses injected HTML without browser', async () => {
    const snippet = encodeURIComponent(`<!doctype html><html><body>
      <div data-item>
        <a href="https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-details/HORIZON-EUSPA-2026-SPACE-02-51">Space Data Economy</a>
        <div>HORIZON-EUSPA-2026-SPACE-02-51 | Calls for proposals</div>
        <div>Opening date: 22 October 2025 | Deadline date: 24 February 2026 | Single-stage</div>
        <div class="badge status">Forthcoming</div>
        <div>Programme: Horizon Europe (HORIZON) | Type of action: HORIZON Innovation Actions</div>
      </div>
    </body></html>`);
    const url = 'http://example.com/?html=' + snippet;
    const request = new IncomingRequest(url);
  const ctx = createExecutionContext(); // retained in case worker adds waitUntil usage later
  const response = await worker.fetch(request, env);
  await waitOnExecutionContext(ctx); // does nothing currently
    const body = await response.text();
    expect(response.headers.get('Content-Type')).toContain('application/rss+xml');
    expect(body).toContain('<rss');
    expect(body).toContain('<channel>');
    expect(body).toContain('<identifier>HORIZON-EUSPA-2026-SPACE-02-51</identifier>');
  });
});
