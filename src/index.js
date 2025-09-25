// Requires a "Browser" binding named BROWSER in Worker settings.
import puppeteer from '@cloudflare/puppeteer';

export default {
  async fetch(req, env) {
    const FEED_URL = new URL(req.url);
    const target =
      FEED_URL.searchParams.get('url') ||
      'https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/calls-for-proposals?isExactMatch=true&status=31094501,31094502&order=DESC&pageNumber=1&pageSize=9999&sortBy=startDate';

    const browser = await puppeteer.launch(env.BROWSER);
    try {
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (compatible; WorkersScraper/1.0)');
      await page.goto(target, { waitUntil: 'networkidle0', timeout: 120000 });

      // Run in the page to extract items from the rendered DOM
      const items = await page.evaluate(() => {
        // Try to find cards/rows that contain links to individual calls.
        // We keep this tolerant to DOM changes by scanning anchor tags that point to /screen/opportunities/
        const anchors = Array.from(document.querySelectorAll('a'))
          .filter(a => (a.href || '').includes('/screen/opportunities/'))
          .map(a => ({
            title: a.getAttribute('title')?.trim()
              || a.textContent?.trim()
              || 'Untitled call',
            link: a.href
          }));

        // Deduplicate by link and keep only meaningful titles
        const byHref = new Map();
        for (const a of anchors) {
          if (!a.title || a.title.length < 6) continue;
          if (!byHref.has(a.link)) byHref.set(a.link, a);
        }

        // Try to enrich with nearby metadata (status, dates) if present
        const results = [];
        for (const { title, link } of byHref.values()) {
          const el = document.querySelector(`a[href="${link}"]`)?.closest('[data-item], li, div, article') || null;
          const text = el?.textContent || '';
          const matchOpen = text.match(/Open(?:s|ing)?:?\s*([0-9]{1,2}\s+\w+\s+[0-9]{4}|\d{4}-\d{2}-\d{2})/i);
          const matchDeadline = text.match(/Deadline:?\s*([0-9]{1,2}\s+\w+\s+[0-9]{4}|\d{4}-\d{2}-\d{2})/i);
          const matchProgramme = text.match(/Programme:?[\s\n]+([^\n]+)\n/i);
          results.push({
            title,
            link,
            opening: matchOpen?.[1] || null,
            deadline: matchDeadline?.[1] || null,
            programme: matchProgramme?.[1]?.trim() || null
          });
        }
        return results;
      });

      // Build RSS
      const esc = s => (s ?? '').replace(/[<&>]/g, c => ({'<':'&lt;','&':'&amp;','>':'&gt;'}[c]));
      const now = new Date().toUTCString();
      const itemsXml = items.map((r) => {
        const pubDate = new Date(r.opening || Date.now()).toUTCString();
        const desc = [
          r.programme && `Programme: ${r.programme}`,
          r.opening && `Opens: ${r.opening}`,
          r.deadline && `Deadline: ${r.deadline}`
        ].filter(Boolean).join('<br/>');
        return `
  <item>
    <guid isPermaLink="true">${esc(r.link)}</guid>
    <title>${esc(r.title)}</title>
    <link>${esc(r.link)}</link>
    <pubDate>${pubDate}</pubDate>
    <description><![CDATA[${desc}]]></description>
  </item>`;
      }).join('');

      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>EU Calls for Proposals — scraped</title>
    <link>${esc(target)}</link>
    <description>Rendered in headless Chromium and scraped</description>
    <lastBuildDate>${now}</lastBuildDate>
    <atom:link href="${esc(FEED_URL.toString())}" rel="self" type="application/rss+xml"/>
    ${itemsXml}
  </channel>
</rss>`;
      return new Response(xml, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });
    } catch (e) {
      return new Response('Scrape error: ' + (e && e.message || e), { status: 500 });
    } finally {
      await browser.close();
    }
  }
};
