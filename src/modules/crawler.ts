import { parseOpportunities } from '../parsePage';
import { isSeen, markSeen } from '../shared/dedup';
import { enqueue, SUMMARIZE_QUEUE_PREFIX } from '../shared/queue';
import type { Env, SummarizeJob } from '../types';

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
	await browser.close();
	return { html, mode: 'browser' };
}

/**
 * Crawler module: Discovers new opportunities and queues them for summarization.
 * Runs on cron schedule (every 2 hours).
 */
export async function handleCrawlerCron(env: Env): Promise<void> {
	console.log('[Crawler] Starting crawl');
	const startTime = Date.now();

	if (!env.SUMMARIES) {
		throw new Error('No SUMMARIES KV namespace binding');
	}

	const target = DEFAULT_FEED_URL;
	let discovered = 0;
	let enqueued = 0;
	let skipped = 0;

	try {
		// Fetch and parse HTML
		const { html } = await fetchListingHtml(target, !!env.BROWSER, env);
		const opportunities = parseOpportunities(html);

		console.log(`[Crawler] Parsed ${opportunities.length} opportunities`);

		// Process each opportunity
		for (const opportunity of opportunities) {
			discovered++;

			// Check if already seen
			const seen = await isSeen(env.SUMMARIES, opportunity.link);

			if (seen) {
				skipped++;
				continue;
			}

			// Not seen before - enqueue for summarization
			const job: SummarizeJob = {
				url: opportunity.link,
				opportunity,
				enqueued: new Date().toISOString(),
				attempts: 0,
			};

			await enqueue(env.SUMMARIES, SUMMARIZE_QUEUE_PREFIX, opportunity.link, job);

			// Mark as seen
			await markSeen(env.SUMMARIES, opportunity.link, {
				identifier: opportunity.identifier,
				title: opportunity.title,
			});

			enqueued++;

			console.log(`[Crawler] Enqueued new opportunity: ${opportunity.identifier || opportunity.title}`);
		}

		const duration = Date.now() - startTime;
		console.log(
			`[Crawler] Complete in ${duration}ms - Discovered: ${discovered}, Enqueued: ${enqueued}, Skipped: ${skipped}`
		);
	} catch (error: any) {
		console.error('[Crawler] Failed:', error?.message || error);
		throw error;
	}
}
