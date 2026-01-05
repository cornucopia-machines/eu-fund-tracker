import { parseOpportunities } from '../parsePage';
import { createPageWithBrowserIfNeeded } from '../shared/browser';
import { isSeen, markSeen } from '../shared/dedup';
import { enqueue, SUMMARIZE_QUEUE_PREFIX } from '../shared/queue';
import { createWorker } from '../shared/worker';
import type { Env, SummarizeJob } from '../types';

const BASE_FEED_URL = `https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/calls-for-proposals?isExactMatch=true&status=31094501,31094502&order=DESC&sortBy=startDate`;
const PAGE_SIZE = 100;

async function fetchListingHtml(
	target: string,
	page: any,
): Promise<{ html: string; page?: any; browser?: any; mode: string }> {
  const useBrowser = !!page;
	console.log(`Fetching listing HTML from ${target} using ${useBrowser ? 'browser' : 'fetch'}`);
	if (!useBrowser) {
		const res = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WorkersScraper/1.0)' } });
		if (!res.ok) throw new Error('Upstream fetch failed: ' + res.status);
		return { html: await res.text(), mode: 'no-browser' };
	}
	await page.goto(target, { waitUntil: 'networkidle0', timeout: 120000 });
	const html = await page.content();
	return { html, mode: 'browser' };
}


/**
 * Crawler module: Discovers new opportunities and queues them for summarization.
 */
async function runOnce(env: Env): Promise<void> {
	if (!env.SUMMARIES) {
		throw new Error('No SUMMARIES KV namespace binding');
	}

	console.log(`[Crawler] Starting crawl -- ${BASE_FEED_URL}`);
	const startTime = Date.now();

	let discovered = 0;
	let enqueued = 0;
	let skipped = 0;
	let pageNumber = 1;

	const { page, browser } = await createPageWithBrowserIfNeeded(env);

	try {
		const baseUrl = new URL(BASE_FEED_URL).origin;

		// Loop through pages until we find a page with no opportunities
		while (true) {
			const target = `${BASE_FEED_URL}&pageNumber=${pageNumber}&pageSize=${PAGE_SIZE}`;
			console.log(`[Crawler] Fetching page ${pageNumber}`);

			// Fetch and parse HTML
			const { html } = await fetchListingHtml(target, page);
			const opportunities = parseOpportunities(html, baseUrl);

			// If no opportunities found on this page, we're done
			if (opportunities.length === 0) {
				console.log(`[Crawler] No opportunities found on page ${pageNumber}, stopping pagination`);
				break;
			}

			console.log(`[Crawler] Parsed ${opportunities.length} opportunities from page ${pageNumber}`);

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

			pageNumber++;
		}

		const duration = Date.now() - startTime;
		console.log(`[Crawler] Complete in ${duration}ms - Discovered: ${discovered}, Enqueued: ${enqueued}, Skipped: ${skipped}`);
	} catch (error: any) {
		console.error('[Crawler] Failed:', error?.message || error);
		throw error;
	} finally {
    await browser?.close();
  }
}

/**
 * Crawler worker - discovers new EU funding opportunities.
 */
export default createWorker(
	{
		name: 'Crawler',
		description: 'Discovers new EU funding opportunities and queues them for summarization',
	},
	runOnce
);
