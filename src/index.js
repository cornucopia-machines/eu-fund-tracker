// Requires a "Browser" binding named BROWSER in Worker settings.
import { parseOpportunities, itemsToRssXml } from './parsePage';
import { enrichWithSummaries } from './summarize';

export default {
  async fetch(req, env) {
    const FEED_URL = new URL(req.url);
    const pageSize = FEED_URL.searchParams.get('pageSize') || '9999';
    const target =
      FEED_URL.searchParams.get('url') ||
      `https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/calls-for-proposals?isExactMatch=true&status=31094501,31094502&order=DESC&pageNumber=1&pageSize=${pageSize}&sortBy=startDate`;

    console.log('Fetching feed for target', target);

    // Direct HTML injection for offline/testing: ?html=<urlencoded raw html>
    const directHtml = FEED_URL.searchParams.get('html');
    if (directHtml) {
      try {
        const raw = decodeURIComponent(directHtml);
        const items = parseOpportunities(raw);
        const { xml } = itemsToRssXml(items, FEED_URL.toString(), target);
        return new Response(xml, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'X-Mode': 'direct-html' } });
      } catch (e) {
        return new Response('Bad html parameter: ' + (e && e.message || e), { status: 400 });
      }
    }

    const wantNoBrowser = !env.BROWSER || FEED_URL.searchParams.get('noBrowser') === '1';
    if (wantNoBrowser) {
      // Fallback: do a simple fetch of the target and parse static HTML (may be empty if site is client-rendered)
      const res = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WorkersScraper/1.0)' } });
      if (!res.ok) {
        return new Response('Upstream fetch failed: ' + res.status, { status: 502 });
      }
      const html = await res.text();
      let items = parseOpportunities(html);
      items = await enrichWithSummaries(items, env, {
        force: FEED_URL.searchParams.get('forceSummary') === '1',
        model: FEED_URL.searchParams.get('summaryModel') || undefined,
        target,
      });
      const { xml } = itemsToRssXml(items, FEED_URL.toString(), target);
      return new Response(xml, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'X-Mode': 'no-browser' } });
    }

    const { default: puppeteer } = await import('@cloudflare/puppeteer');
    const browser = await puppeteer.launch(env.BROWSER);
    try {
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (compatible; WorkersScraper/1.0)');
      await page.goto(target, { waitUntil: 'networkidle0', timeout: 120000 });

      // Offline test shortcut: if ?raw=1 and body provided (POST) parse directly, or if ?offline=1 just return parser stub.
      if (FEED_URL.searchParams.get('offline') === '1') {
        const sample = '<html><body><p>Offline test mode enabled</p></body></html>';
        const { xml } = itemsToRssXml([], FEED_URL.toString(), target);
        return new Response(xml, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'X-Offline': '1' } });
      }

      // Run in the page: grab HTML then feed to shared parser (so we test same code path as offline)
      const html = await page.content();
      let items = parseOpportunities(html);
      // Provide the same page instance for summaries to optionally reuse (will navigate per item)
      items = await enrichWithSummaries(items, env, {
        force: FEED_URL.searchParams.get('forceSummary') === '1',
        model: FEED_URL.searchParams.get('summaryModel') || undefined,
        target,
        browserPage: page,
      });
      const { xml } = itemsToRssXml(items, FEED_URL.toString(), target);
      return new Response(xml, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
    } catch (e) {
      return new Response('Scrape error: ' + (e && e.message || e), { status: 500 });
    } finally {
      // Close only if defined (guarding against early returns in no-browser path)
      try { await browser?.close(); } catch { }
    }
  }
};
