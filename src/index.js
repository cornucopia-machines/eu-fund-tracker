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
        // Collect anchors that look like individual opportunity detail links.
        const rawAnchors = Array.from(document.querySelectorAll('a'))
          .filter(a => (a.href || '').includes('/screen/opportunities/'));

        const dedup = new Map();
        for (const a of rawAnchors) {
          const title = a.getAttribute('title')?.trim() || a.textContent?.trim() || '';
            // Skip very short / non-informative titles
          if (title.length < 6) continue;
          if (!dedup.has(a.href)) dedup.set(a.href, { a, title });
        }

        const STATUS_WORDS = ['Forthcoming','Open For Submission','Open','Closed','Cancelled','Suspended'];

        const results = [];
        for (const { a, title } of dedup.values()) {
          const link = a.href;
          // Heuristic: closest reasonably sized container
          const container = a.closest('[data-item], article, li, div');
          const text = (container?.textContent || '').replace(/\s+/g,' ').trim();
          // We'll also split into logical lines by recognising capitalised tokens separated by double spaces or pipes in original markup if any
          // but since we normalised spaces we rely on regex extraction below.

          // Identifier + announcement type pattern e.g. HORIZON-EUSPA-2026-SPACE-02-51 | Calls for proposals
          const idAndType = text.match(/([A-Z0-9][A-Z0-9-]{5,})\s*\|\s*([^|]*?(Calls? for proposals?|Tenders?|Grants?))/i);
          const identifier = idAndType?.[1] || null;
          const announcementType = idAndType?.[2]?.trim() || null;

          // Opening / deadline dates
          const openingMatch = text.match(/Opening date:?\s*([0-9]{1,2}\s+\w+\s+[0-9]{4}|\d{4}-\d{2}-\d{2})/i) || text.match(/Open(?:s|ing)?:?\s*([0-9]{1,2}\s+\w+\s+[0-9]{4}|\d{4}-\d{2}-\d{2})/i);
          const deadlineMatch = text.match(/Deadline date:?\s*([0-9]{1,2}\s+\w+\s+[0-9]{4}|\d{4}-\d{2}-\d{2})/i) || text.match(/Deadline:?\s*([0-9]{1,2}\s+\w+\s+[0-9]{4}|\d{4}-\d{2}-\d{2})/i);

          // Status label - search DOM directly first (often in a badge), then fallback to regex.
          let status = null;
          if (container) {
            const badge = container.querySelector('[class*="status" i], [class*="badge" i]');
            status = badge?.textContent?.trim() || null;
          }
          if (!status) {
            const statusRegex = new RegExp('(' + STATUS_WORDS.map(s => s.replace(/ /g,'\\s+')).join('|') + ')','i');
            status = text.match(statusRegex)?.[1] || null;
          }

          // Programme and type of action line
          const programmeMatch = text.match(/Programme:?\s*([^|]+?)(?:\s*\|\s*Type of action:|$)/i);
          const programmeName = programmeMatch?.[1]?.trim() || null;
          const actionMatch = text.match(/Type of action:?\s*([^|]+?)(?:\s*$|\s*Programme:)/i);
          const actionType = actionMatch?.[1]?.trim() || null;

            // Stage (Single-stage / Two-stage)
          const stageMatch = text.match(/(Single-stage|Two-stage)/i);
          const stage = stageMatch?.[1] || null;

          results.push({
            title: title || 'Untitled call',
            link,
            identifier,
            announcementType,
            status,
            opening: openingMatch?.[1] || null,
            deadline: deadlineMatch?.[1] || null,
            programmeName,
            actionType,
            stage
          });
        }
        return results;
      });

      // Build RSS
      const esc = s => (s ?? '').replace(/[<&>]/g, c => ({'<':'&lt;','&':'&amp;','>':'&gt;'}[c]));
      const now = new Date().toUTCString();
      const itemsXml = items.map((r) => {
        const pubDate = new Date(r.opening || Date.now()).toUTCString();
        const lines = [
          r.identifier && `${r.identifier}${r.announcementType ? ' | ' + r.announcementType : ''}`,
          (r.opening || r.deadline || r.stage) && [
            r.opening && `Opening date: ${r.opening}`,
            r.deadline && `Deadline date: ${r.deadline}`,
            r.stage && r.stage
          ].filter(Boolean).join(' | '),
          r.status && r.status,
          (r.programmeName || r.actionType) && [
            r.programmeName && `Programme: ${r.programmeName}`,
            r.actionType && `Type of action: ${r.actionType}`
          ].filter(Boolean).join(' | ')
        ].filter(Boolean);
        const desc = lines.join('<br/>');
        return `
  <item>
    <guid isPermaLink="true">${esc(r.link)}</guid>
    <title>${esc(r.title)}</title>
    <link>${esc(r.link)}</link>
    <pubDate>${pubDate}</pubDate>
    <description><![CDATA[${desc}]]></description>
    ${r.identifier ? `<identifier>${esc(r.identifier)}</identifier>` : ''}
    ${r.announcementType ? `<announcementType>${esc(r.announcementType)}</announcementType>` : ''}
    ${r.status ? `<status>${esc(r.status)}</status>` : ''}
    ${r.opening ? `<openingDate>${esc(r.opening)}</openingDate>` : ''}
    ${r.deadline ? `<deadlineDate>${esc(r.deadline)}</deadlineDate>` : ''}
    ${r.programmeName ? `<programmeName>${esc(r.programmeName)}</programmeName>` : ''}
    ${r.actionType ? `<actionType>${esc(r.actionType)}</actionType>` : ''}
    ${r.stage ? `<stage>${esc(r.stage)}</stage>` : ''}
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
