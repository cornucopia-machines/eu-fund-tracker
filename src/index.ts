import { Duration } from 'luxon';
import { parseOpportunities, itemsToRssXml } from './parsePage';
import { enrichWithSummaries } from './summarize';
import type { Env, Opportunity } from './types';

// Key for storing latest snapshot JSON
const SNAPSHOT_KEY = 'snapshot:items:v1';
const DEFAULT_FEED_URL = `https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/calls-for-proposals?isExactMatch=true&status=31094501,31094502&order=DESC&pageNumber=1&pageSize=9999&sortBy=startDate`;

async function fetchListingHtml(
	target: string,
	useBrowser: boolean,
	env: Env
): Promise<{ html: string; page?: any; browser?: any; mode: string }> {
  console.log(`Fetching listing HTML from ${target} using ${useBrowser ? 'browser' : 'fetch'}`);
	if (!useBrowser) {
		const res = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WorkersScraper/1.0)' } });
		if (!res.ok) throw new Error('Upstream fetch failed: ' + res.status);
		return { html: await res.text(), mode: 'no-browser' };
	}
	const puppeteer: any = await import('@cloudflare/puppeteer');
	const browser = await puppeteer.launch(env.BROWSER);
	const page = await browser.newPage();
	await page.setUserAgent('Mozilla/5.0 (compatible; WorkersScraper/1.0)');
	await page.goto(target, { waitUntil: 'networkidle0', timeout: 120000 });
	const html = await page.content();
	return { html, page, browser, mode: 'browser' };
}

async function buildAndStoreSnapshot(target: string, env: Env) {
	const { html, page, browser } = await fetchListingHtml(target, !!env.BROWSER, env);
	try {
		let items = parseOpportunities(html);
		items = await enrichWithSummaries(items, env, { force: false, browserPage: page, model: env.SUMMARY_MODEL, target });
		const snapshot = { updatedAt: new Date().toISOString(), target, count: items.length, items };
		if (!env.SUMMARIES) {
			throw new Error('No SUMMARIES KV namespace binding');
		}
		await env.SUMMARIES.put(SNAPSHOT_KEY, JSON.stringify(snapshot), {
			expirationTtl: Duration.fromObject({ days: 1 }).as('seconds'),
		});
		return snapshot;
	} finally {
		try {
			await browser?.close();
		} catch {}
	}
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const FEED_URL = new URL(req.url);
		const target = FEED_URL.searchParams.get('url') || DEFAULT_FEED_URL;

		console.log('Fetching feed for target', target);

		// Direct injected HTML test path
		const directHtml = FEED_URL.searchParams.get('html');
		if (directHtml) {
			try {
				const html = decodeURIComponent(directHtml);
				let items = parseOpportunities(html);
				const xml = itemsToRssXml(items, FEED_URL.toString(), target).xml;
				return new Response(xml, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'X-Mode': 'direct-html' } });
			} catch (e: any) {
				return new Response('Bad html parameter: ' + (e?.message || e), { status: 400 });
			}
		}

		// Fast path: if snapshot exists and not forced refresh, serve from KV
		if (!env.SUMMARIES) {
			throw new Error('No SUMMARIES KV namespace binding');
		}
		const rawSnapshot = await env.SUMMARIES.get(SNAPSHOT_KEY);
		if (rawSnapshot) {
			const snapshot = JSON.parse(rawSnapshot) as { items: Opportunity[]; updatedAt: string; target: string };
			const { xml } = itemsToRssXml(snapshot.items, FEED_URL.toString(), target);
			return new Response(xml, {
				headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'X-Mode': 'snapshot', 'X-Updated-At': snapshot.updatedAt },
			});
		}

		throw new Error("Summaries haven't been generated yet");
	},

	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		try {
      console.log('Scheduled snapshot build starting');
			await buildAndStoreSnapshot(DEFAULT_FEED_URL, env);
			console.log('Snapshot updated');
		} catch (e: any) {
			console.error('Snapshot build failed', e?.message || e);
		}
	},
};
