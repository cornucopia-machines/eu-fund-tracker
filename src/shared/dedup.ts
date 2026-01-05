import { Duration } from 'luxon';

const SEEN_KEY = 'seen:all';
const SEEN_TTL_DAYS = 90;

export interface SeenRecord {
	url: string;
	firstSeen: string;
	identifier: string | null;
	title: string;
}

export interface SeenDatabase {
	[urlHash: string]: SeenRecord;
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
 * Load the entire seen database from KV.
 */
async function loadSeenDatabase(kv: KVNamespace): Promise<SeenDatabase> {
	const raw = await kv.get(SEEN_KEY);
	if (!raw) return {};
	return JSON.parse(raw) as SeenDatabase;
}

/**
 * Save the seen database to KV.
 */
async function saveSeenDatabase(kv: KVNamespace, db: SeenDatabase): Promise<void> {
	await kv.put(SEEN_KEY, JSON.stringify(db), {
		expirationTtl: Duration.fromObject({ days: SEEN_TTL_DAYS }).as('seconds'),
	});
}

/**
 * Check if a URL has been seen before.
 */
export async function isSeen(kv: KVNamespace, url: string): Promise<boolean> {
	const db = await loadSeenDatabase(kv);
	return hashUrl(url) in db;
}

/**
 * Check which URLs from a list have been seen before.
 * Returns a Set of URL hashes that have been seen.
 */
export async function filterSeen(kv: KVNamespace, urls: string[]): Promise<Set<string>> {
	const db = await loadSeenDatabase(kv);
	const seen = new Set<string>();

	for (const url of urls) {
		const hash = hashUrl(url);
		if (hash in db) {
			seen.add(url);
		}
	}

	return seen;
}

/**
 * Mark a URL as seen with metadata.
 */
export async function markSeen(
	kv: KVNamespace,
	url: string,
	metadata: { identifier: string | null; title: string }
): Promise<void> {
	const db = await loadSeenDatabase(kv);
	const urlHash = hashUrl(url);

	db[urlHash] = {
		url,
		firstSeen: new Date().toISOString(),
		identifier: metadata.identifier,
		title: metadata.title,
	};

	await saveSeenDatabase(kv, db);
}

/**
 * Mark multiple URLs as seen with metadata (batch operation).
 */
export async function markSeenBatch(
	kv: KVNamespace,
	items: Array<{ url: string; metadata: { identifier: string | null; title: string } }>
): Promise<void> {
	const db = await loadSeenDatabase(kv);
	const timestamp = new Date().toISOString();

	for (const item of items) {
		const urlHash = hashUrl(item.url);
		db[urlHash] = {
			url: item.url,
			firstSeen: timestamp,
			identifier: item.metadata.identifier,
			title: item.metadata.title,
		};
	}

	await saveSeenDatabase(kv, db);
}

/**
 * Get the seen record for a URL (for debugging/inspection).
 */
export async function getSeenRecord(kv: KVNamespace, url: string): Promise<SeenRecord | null> {
	const db = await loadSeenDatabase(kv);
	const urlHash = hashUrl(url);
	return db[urlHash] || null;
}
