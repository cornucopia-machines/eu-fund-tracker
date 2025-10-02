// Pure HTML parser for opportunity listings.
// We keep regex / DOM heuristics similar to the in-browser evaluate() logic so tests can exercise it offline.
import { parseHTML } from 'linkedom';

export function parseOpportunities(html) {
  const { document } = parseHTML(html);

  const rawAnchors = Array.from(document.querySelectorAll('a'))
    .filter(a => (a.href || '').includes('/screen/opportunities/'));

  const dedup = new Map();
  for (const a of rawAnchors) {
    const title = a.getAttribute('title')?.trim() || a.textContent?.trim() || '';
    if (title.length < 6) continue;
    if (!dedup.has(a.href)) dedup.set(a.href, { a, title });
  }

  const STATUS_WORDS = ['Forthcoming','Open For Submission','Open','Closed','Cancelled','Suspended'];

  const results = [];
  for (const { a, title } of dedup.values()) {
    const link = a.href;
    const container = a.closest('[data-item], article, li, div');
    const text = (container?.textContent || '').replace(/\s+/g,' ').trim();

    const idAndType = text.match(/([A-Z0-9][A-Z0-9-]{5,})\s*\|\s*([^|]*?(Calls? for proposals?|Tenders?|Grants?))/i);
    const identifier = idAndType?.[1] || null;
    const announcementType = idAndType?.[2]?.trim() || null;

    const openingMatch = text.match(/Opening date:?\s*([0-9]{1,2}\s+\w+\s+[0-9]{4}|\d{4}-\d{2}-\d{2})/i) || text.match(/Open(?:s|ing)?:?\s*([0-9]{1,2}\s+\w+\s+[0-9]{4}|\d{4}-\d{2}-\d{2})/i);
    const deadlineMatch = text.match(/Deadline date:?\s*([0-9]{1,2}\s+\w+\s+[0-9]{4}|\d{4}-\d{2}-\d{2})/i) || text.match(/Deadline:?\s*([0-9]{1,2}\s+\w+\s+[0-9]{4}|\d{4}-\d{2}-\d{2})/i);

    let status = null;
    if (container) {
      const badge = container.querySelector('[class*="status" i], [class*="badge" i]');
      status = badge?.textContent?.trim() || null;
    }
    if (!status) {
      const statusRegex = new RegExp('(' + STATUS_WORDS.map(s => s.replace(/ /g,'\\s+')).join('|') + ')','i');
      status = text.match(statusRegex)?.[1] || null;
    }

    const programmeMatch = text.match(/Programme:?\s*([^|]+?)(?:\s*\|\s*Type of action:|$)/i);
    const programmeName = programmeMatch?.[1]?.trim() || null;
    const actionMatch = text.match(/Type of action:?\s*([^|]+?)(?:\s*$|\s*Programme:)/i);
    const actionType = actionMatch?.[1]?.trim() || null;

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
}

export function itemsToRssXml(items, feedUrl, targetUrl) {
  const esc = s => (s ?? '').replace(/[<&>]/g, c => ({'<':'&lt;','&':'&amp;','>':'&gt;'}[c]));
  const now = new Date().toUTCString();
  const itemsXml = items.map(r => {
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
    return `\n  <item>\n    <guid isPermaLink="true">${esc(r.link)}</guid>\n    <title>${esc(r.title)}</title>\n    <link>${esc(r.link)}</link>\n    <pubDate>${pubDate}</pubDate>\n    <description><![CDATA[${desc}]]></description>\n    ${r.identifier ? `<identifier>${esc(r.identifier)}</identifier>` : ''}\n    ${r.announcementType ? `<announcementType>${esc(r.announcementType)}</announcementType>` : ''}\n    ${r.status ? `<status>${esc(r.status)}</status>` : ''}\n    ${r.opening ? `<openingDate>${esc(r.opening)}</openingDate>` : ''}\n    ${r.deadline ? `<deadlineDate>${esc(r.deadline)}</deadlineDate>` : ''}\n    ${r.programmeName ? `<programmeName>${esc(r.programmeName)}</programmeName>` : ''}\n    ${r.actionType ? `<actionType>${esc(r.actionType)}</actionType>` : ''}\n    ${r.stage ? `<stage>${esc(r.stage)}</stage>` : ''}\n  </item>`;
  }).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n  <channel>\n    <title>EU Calls for Proposals — scraped</title>\n    <link>${esc(targetUrl)}</link>\n    <description>Rendered in headless Chromium and scraped</description>\n    <lastBuildDate>${now}</lastBuildDate>\n    <atom:link href="${esc(feedUrl)}" rel="self" type="application/rss+xml"/>\n    ${itemsXml}\n  </channel>\n</rss>`;
  return { xml, itemsXml };
}
