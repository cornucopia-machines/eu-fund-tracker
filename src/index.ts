import { parseOpportunities, itemsToRssXml } from './parsePage';
import { enrichWithSummaries } from './summarize';
import type { Env } from './types';

interface FetchParams {
	summarize: boolean;
	forceSummary: boolean;
	summaryModel?: string;
	pageSize: string;
}

function extractParams(url: URL): FetchParams {
	return {
		summarize: url.searchParams.get('summarize') !== '0',
		forceSummary: url.searchParams.get('forceSummary') === '1',
		summaryModel: url.searchParams.get('summaryModel') || undefined,
		pageSize: url.searchParams.get('pageSize') || '9999',
	};
}

async function buildRss(itemsHtml: string, feedUrl: string, target: string, env: Env, p: FetchParams, browserPage?: any) {
	let items = parseOpportunities(itemsHtml);
	if (p.summarize) {
		items = await enrichWithSummaries(items, env, {
			force: p.forceSummary,
			model: p.summaryModel,
			target,
			browserPage,
		});
	}
	return itemsToRssXml(items, feedUrl, target).xml;
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const FEED_URL = new URL(req.url);
		const params = extractParams(FEED_URL);
		const target =
			FEED_URL.searchParams.get('url') ||
			`https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/calls-for-proposals?isExactMatch=true&status=31094501,31094502&order=DESC&pageNumber=1&pageSize=${params.pageSize}&sortBy=startDate`;

		console.log('Fetching feed for target', target);

		// Direct injected HTML test path
		const directHtml = FEED_URL.searchParams.get('html');
		if (directHtml) {
			try {
				const html = decodeURIComponent(directHtml);
				const xml = await buildRss(html, FEED_URL.toString(), target, env, params);
				return new Response(xml, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'X-Mode': 'direct-html' } });
			} catch (e: any) {
				return new Response('Bad html parameter: ' + (e?.message || e), { status: 400 });
			}
		}

		// Browser path
		const puppeteer: any = await import('@cloudflare/puppeteer');
		const browser = await puppeteer.launch(env.BROWSER);
		try {
			const page = await browser.newPage();
			await page.setUserAgent('Mozilla/5.0 (compatible; WorkersScraper/1.0)');
			await page.goto(target, { waitUntil: 'networkidle0', timeout: 120000 });
			const html = await page.content();
			const xml = await buildRss(html, FEED_URL.toString(), target, env, params, page);
			return new Response(xml, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
		} catch (e: any) {
			return new Response('Scrape error: ' + (e?.message || e), { status: 500 });
		} finally {
			try {
				await browser?.close();
			} catch {}
		}
	},
};
