import { parseHTML } from 'linkedom';
import type { Opportunity } from './types';

/** Parse listing HTML into opportunity objects. */
export function parseOpportunities(html: string): Opportunity[] {
	const { document } = parseHTML(html);

	// Collect anchors that point to opportunity detail pages (topic-details or competitive calls etc.)
	const rawAnchors = Array.from(document.querySelectorAll('a')).filter((a: any) =>
		(a.getAttribute('href') || '').includes('/screen/opportunities/')
	) as any[];

	const dedup = new Map<string, { a: any; title: string }>();
	for (const a of rawAnchors) {
		const title = (a.getAttribute('title')?.trim() || a.textContent?.trim() || '').trim();
		if (title.length < 6) continue;
		const href = a.href;
		if (!dedup.has(href)) dedup.set(href, { a, title });
	}

	const STATUS_WORDS = ['Forthcoming', 'Open For Submission', 'Open', 'Closed', 'Cancelled', 'Suspended'];
	const results: Opportunity[] = [];

	for (const { a, title } of dedup.values()) {
		const link = a.href;
		// Find the most specific card root so we can extract all related metadata spans.
		const cardRoot =
			a.closest('eui-card, sedia-result-card, sedia-result-card-calls-for-proposals') || a.closest('[data-item], article, li, div');
		const text = (cardRoot?.textContent || '').replace(/\s+/g, ' ').trim();

		// Extract identifier + announcement type using structural hints first (subtitle spans) to avoid title bleed.
		let identifier: string | null = null;
		let announcementType: string | null = null;
		if (cardRoot) {
			const subtitle = cardRoot.querySelector('eui-card-header-subtitle');
			if (subtitle) {
				const spanTexts = Array.from(subtitle.querySelectorAll('span'))
					.map((s: any) => s.textContent?.trim() || '')
					.filter(Boolean);
				// announcement type is one that matches known keywords and may contain spaces.
				const annIndex = spanTexts.findIndex((t) => /(Calls? for proposals?|Cascade funding|Tenders?|Grants?)/i.test(t));
				if (annIndex !== -1) announcementType = spanTexts[annIndex];
				// Candidate identifiers: spans without spaces OR with many hyphens but not matching announcement keywords.
				const codeCandidates = spanTexts.filter(
					(t, i) => i !== annIndex && !/(Calls? for proposals?|Cascade funding|Tenders?|Grants?)/i.test(t)
				);
				const structuredCodes = codeCandidates.filter(
					(t) => /[A-Z0-9]{2,}-[A-Z0-9]{2,}/i.test(t) || (!t.includes(' ') && /[A-Za-z0-9]/.test(t))
				);
				if (structuredCodes.length) {
					structuredCodes.sort((a, b) => b.split('-').length - a.split('-').length || b.length - a.length);
					identifier = structuredCodes[0];
				}
			}
		}
		// Fallback regex across combined text if structural parse failed.
		if (!identifier) {
			const idPattern = /([A-Z0-9][A-Z0-9-]{5,})\s*\|\s*([^|]*?(Calls? for proposals?|Cascade funding|Tenders?|Grants?))/i;
			const m = text.match(idPattern);
			if (m) {
				identifier = m[1].trim();
				announcementType = announcementType || m[2].trim();
			}
		}

		const openingMatch =
			text.match(/Opening date:?\s*([0-9]{1,2}\s+\w+\s+[0-9]{4}|\d{4}-\d{2}-\d{2})/i) ||
			text.match(/Open(?:s|ing)?:?\s*([0-9]{1,2}\s+\w+\s+[0-9]{4}|\d{4}-\d{2}-\d{2})/i);
		const deadlineMatch =
			text.match(/Deadline date:?\s*([0-9]{1,2}\s+\w+\s+[0-9]{4}|\d{4}-\d{2}-\d{2})/i) ||
			text.match(/Deadline:?\s*([0-9]{1,2}\s+\w+\s+[0-9]{4}|\d{4}-\d{2}-\d{2})/i);

		let status: string | null = null;
		if (cardRoot) {
			const badge = cardRoot.querySelector('[class*="status" i], [class*="badge" i], eui-chip');
			status = badge?.textContent?.trim() || null;
		}
		if (!status) {
			const statusRegex = new RegExp('(' + STATUS_WORDS.map((s) => s.replace(/ /g, '\\s+')).join('|') + ')', 'i');
			status = text.match(statusRegex)?.[1] || null;
		}

		const programmeMatch = text.match(/Programme:?\s*([^|]+?)(?:\s*\|\s*Type of action:|$)/i);
		const programmeName = programmeMatch?.[1]?.trim() || null;
		const actionMatch = text.match(/Type of action:?\s*([^|]+?)(?:\s*$|\s*Programme:)/i);
		const actionType = actionMatch?.[1]?.trim() || null;
		const stageMatch = text.match(/(Single-stage|Two-stage)/i);
		const stage = stageMatch?.[1] || null;

		// Additional fallbacks for identifier if relaxed pattern gave us something too generic or null.
		if (!identifier || /Opening date:/i.test(identifier)) {
			// Try to extract a strong code pattern inside text (many hyphens & digits)
			const strongCode = text.match(/([A-Z0-9]{2,}(?:-[A-Z0-9]{2,}){2,}(?:-[A-Z0-9][A-Z0-9-]{1,})?)/);
			if (strongCode) identifier = strongCode[1];
		}
		if (!identifier) {
			// Fallback: numeric id from competitive-calls-cs/{id}
			const numericId = link.match(/competitive-calls-cs\/(\d+)/i)?.[1];
			if (numericId) identifier = numericId;
		}
		if (!identifier) {
			const firstSegment = text
				.split('|')[0]
				.trim()
				.split(/\s{2,}/)[0]
				.trim();
			// As a last resort use the first word(s) before a pipe if present
			if (firstSegment && firstSegment.length < 60) identifier = firstSegment;
		}

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
			stage,
		});
	}
	return results;
}
