import { parseOpportunities } from '../src/parsePage';
import { describe, it, expect } from 'vitest';

// NOTE: The downloaded page is an initial shell (Angular app) and may not contain the rendered list.
// This test is illustrative; once you capture post-render HTML (e.g., via page.content()) replace fixture.

describe('parseOpportunities', () => {
  it('parses synthetic snippet with expected fields', () => {
    const snippet = `<!doctype html><html><body>
      <div data-item>
        <a href="https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-details/HORIZON-EUSPA-2026-SPACE-02-51">Space Data Economy</a>
        <div>HORIZON-EUSPA-2026-SPACE-02-51 | Calls for proposals</div>
        <div>Opening date: 22 October 2025 | Deadline date: 24 February 2026 | Single-stage</div>
        <div class="status-badge">Forthcoming</div>
        <div>Programme: Horizon Europe (HORIZON) | Type of action: HORIZON Innovation Actions</div>
      </div>
    </body></html>`;
    const items = parseOpportunities(snippet);
    expect(items.length).toBe(1);
    const item = items[0];
    expect(item.identifier).toBe('HORIZON-EUSPA-2026-SPACE-02-51');
    expect(item.announcementType?.toLowerCase()).toContain('calls for proposals');
    expect(item.status).toBe('Forthcoming');
    expect(item.opening).toBe('22 October 2025');
    expect(item.deadline).toBe('24 February 2026');
    expect(item.programmeName).toBe('Horizon Europe (HORIZON)');
    expect(item.actionType).toBe('HORIZON Innovation Actions');
    expect(item.stage).toBe('Single-stage');
  });
});
