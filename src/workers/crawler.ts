import { parseOpportunities } from '../parsePage';
import { createPageWithBrowserIfNeeded } from '../shared/browser';
import { filterSeen, markSeenBatch } from '../shared/dedup';
import { enqueue, SUMMARIZE_QUEUE_PREFIX } from '../shared/queue';
import { createWorker } from '../shared/worker';
import type { Env, SummarizeBatchJob, Opportunity } from '../types';

const BASE_FEED_URL = `https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/calls-for-proposals?isExactMatch=true&status=31094501,31094502&order=DESC&sortBy=startDate`;
const PAGE_SIZE = 100;

async function fetchListingHtml(target: string, page: any): Promise<{ html: string; page?: any; browser?: any; mode: string }> {
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

	const { page, browser } = await createPageWithBrowserIfNeeded(env);
	const baseUrl = new URL(BASE_FEED_URL).origin;
	const allOpportunities: any[] = [];

	try {
		// Phase 1: Fetch and parse all pages (minimize browser usage time)
		let pageNumber = 1;
		while (true) {
			const target = `${BASE_FEED_URL}&pageNumber=${pageNumber}&pageSize=${PAGE_SIZE}`;
			console.log(`[Crawler] Fetching page ${pageNumber}`);

			// Fetch and parse HTML
			const { html } = await fetchListingHtml(target, page);
			const opportunities = parseOpportunities(html, baseUrl);

			// If no opportunities found on this page, we're done fetching
			if (opportunities.length === 0) {
				console.log(`[Crawler] No opportunities found on page ${pageNumber}, stopping pagination`);
				break;
			}

			console.log(`[Crawler] Parsed ${opportunities.length} opportunities from page ${pageNumber}`);
			allOpportunities.push(...opportunities);
			pageNumber++;
		}

		console.log(`[Crawler] Fetched ${allOpportunities.length} total opportunities from ${pageNumber - 1} pages`);
	} catch (error: any) {
		console.error('[Crawler] Failed during fetch phase:', error);
		if (error?.stack) {
			console.error('[Crawler] Stack trace:', error.stack);
		}
		throw error;
	} finally {
		// Close browser as soon as we're done fetching
		await browser?.close();
	}

	// Phase 2: Filter out already-seen opportunities (single KV call)
	try {
		discovered = allOpportunities.length;
		console.log(`[Crawler] Checking which of ${discovered} opportunities are new...`);

		const allUrls = allOpportunities.map((opp) => opp.link);
		const seenUrls = await filterSeen(env.SUMMARIES, allUrls);

		const newOpportunities = allOpportunities.filter((opp) => !seenUrls.has(opp.link));
		skipped = discovered - newOpportunities.length;

		console.log(`[Crawler] Found ${newOpportunities.length} new opportunities (${skipped} already seen)`);

		if (newOpportunities.length === 0) {
			const duration = Date.now() - startTime;
			console.log(`[Crawler] Complete in ${duration}ms - No new opportunities to process`);
			return;
		}

		// Phase 3: Batch new opportunities into groups of 10
    const batchSize = parseInt(env.SUMMARIZER_BATCH_SIZE || '10', 10);
		const batches: Opportunity[][] = [];

		for (let i = 0; i < newOpportunities.length; i += batchSize) {
			batches.push(newOpportunities.slice(i, i + batchSize));
		}

		console.log(`[Crawler] Created ${batches.length} batches of up to ${batchSize} opportunities`);

		// Phase 4: Enqueue batches (one KV write per batch)
		const timestamp = new Date().toISOString();
		for (let i = 0; i < batches.length; i++) {
			const batch = batches[i];
			const batchId = `batch-${Date.now()}-${i}`;

			const batchJob: SummarizeBatchJob = {
				batchId,
				opportunities: batch,
				enqueued: timestamp,
				attempts: 0,
			};

			// Use first opportunity's URL as the key for the batch
			await enqueue(env.SUMMARIES, SUMMARIZE_QUEUE_PREFIX, batchId, batchJob);

			enqueued += batch.length;
			console.log(`[Crawler] Enqueued batch ${i + 1}/${batches.length} with ${batch.length} opportunities`);
		}

		// Phase 5: Mark all new opportunities as seen (single KV write)
		const seenItems = newOpportunities.map((opp) => ({
			url: opp.link,
			metadata: {
				identifier: opp.identifier,
				title: opp.title,
			},
		}));

		await markSeenBatch(env.SUMMARIES, seenItems);
		console.log(`[Crawler] Marked ${seenItems.length} opportunities as seen`);
	} catch (error: any) {
		console.error('[Crawler] Failed during processing phase:', error);
		if (error?.stack) {
			console.error('[Crawler] Stack trace:', error.stack);
		}
		throw error;
	}

	const duration = Date.now() - startTime;
	console.log(`[Crawler] Complete in ${duration}ms - Discovered: ${discovered}, Enqueued: ${enqueued}, Skipped: ${skipped}`);
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
