import { Duration } from 'luxon';

const SEEN_PREFIX = 'seen:';
const SEEN_TTL_DAYS = 90;

export interface SeenRecord {
	url: string;
	firstSeen: string;
	identifier: string | null;
	title: string;
}

/**
 * Generate a consistent hash for a URL to use as KV key suffix.
 * Uses a simple hash algorithm suitable for key generation.
 */
export function hashUrl(url: string): string {
	let hash = 0;
	for (let i = 0; i < url.length; i++) {
		const char = url.charCodeAt(i);
		hash = (hash << 5) - hash + char;
		hash = hash & hash; // Convert to 32bit integer
	}
	return Math.abs(hash).toString(36);
}

/**
 * Check if a URL has been seen before.
 */
export async function isSeen(kv: KVNamespace, url: string): Promise<boolean> {
	const key = SEEN_PREFIX + hashUrl(url);
	const record = await kv.get(key);
	return record !== null;
}

/**
 * Mark a URL as seen with metadata.
 */
export async function markSeen(
	kv: KVNamespace,
	url: string,
	metadata: { identifier: string | null; title: string }
): Promise<void> {
	const key = SEEN_PREFIX + hashUrl(url);
	const record: SeenRecord = {
		url,
		firstSeen: new Date().toISOString(),
		identifier: metadata.identifier,
		title: metadata.title,
	};
	await kv.put(key, JSON.stringify(record), {
		expirationTtl: Duration.fromObject({ days: SEEN_TTL_DAYS }).as('seconds'),
	});
}

/**
 * Get the seen record for a URL (for debugging/inspection).
 */
export async function getSeenRecord(kv: KVNamespace, url: string): Promise<SeenRecord | null> {
	const key = SEEN_PREFIX + hashUrl(url);
	const raw = await kv.get(key);
	if (!raw) return null;
	return JSON.parse(raw) as SeenRecord;
}
