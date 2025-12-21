import { Duration } from 'luxon';
import { hashUrl } from './dedup';

export const SUMMARIZE_QUEUE_PREFIX = 'queue:summarize:';
export const NOTIFY_QUEUE_PREFIX = 'queue:notify:';
export const PROCESSING_PREFIX = 'processing:';
export const DLQ_SUMMARIZE_PREFIX = 'dlq:summarize:';
export const DLQ_NOTIFY_PREFIX = 'dlq:notify:';

const QUEUE_TTL_DAYS = 7;
const PROCESSING_TTL_MINUTES = 15;
const DLQ_TTL_DAYS = 30;

export interface QueueJob {
	attempts: number;
	lastAttempt?: string;
	error?: string;
}

/**
 * Enqueue an item to a KV-based queue.
 * Key format: {prefix}{timestamp}:{urlHash}
 */
export async function enqueue<T extends QueueJob>(
	kv: KVNamespace,
	prefix: string,
	url: string,
	value: T
): Promise<string> {
	const timestamp = Date.now();
	const urlHash = hashUrl(url);
	const key = `${prefix}${timestamp}:${urlHash}`;

	await kv.put(key, JSON.stringify(value), {
		expirationTtl: Duration.fromObject({ days: QUEUE_TTL_DAYS }).as('seconds'),
	});

	return key;
}

/**
 * List pending queue items by prefix.
 * Returns full queue keys, sorted by timestamp (oldest first).
 */
export async function listPending(kv: KVNamespace, prefix: string, limit: number = 50): Promise<string[]> {
	const result = await kv.list({ prefix, limit });
	return result.keys.map((k) => k.name).sort();
}

/**
 * Attempt to claim a job for processing.
 * Returns true if claim successful, false if already claimed.
 */
export async function claim(kv: KVNamespace, url: string): Promise<boolean> {
	const urlHash = hashUrl(url);
	const processingKey = PROCESSING_PREFIX + urlHash;

	// Try to claim by putting a processing marker
	const existing = await kv.get(processingKey);
	if (existing) {
		// Already claimed
		return false;
	}

	// Claim it
	await kv.put(processingKey, new Date().toISOString(), {
		expirationTtl: Duration.fromObject({ minutes: PROCESSING_TTL_MINUTES }).as('seconds'),
	});

	return true;
}

/**
 * Release a processing claim (e.g., on rate limit, want to retry later).
 */
export async function release(kv: KVNamespace, url: string): Promise<void> {
	const urlHash = hashUrl(url);
	const processingKey = PROCESSING_PREFIX + urlHash;
	await kv.delete(processingKey);
}

/**
 * Complete a job successfully - remove from queue and processing.
 */
export async function complete(kv: KVNamespace, queueKey: string, url: string): Promise<void> {
	const urlHash = hashUrl(url);
	const processingKey = PROCESSING_PREFIX + urlHash;

	await Promise.all([kv.delete(queueKey), kv.delete(processingKey)]);
}

/**
 * Handle a failed job attempt.
 * Increments attempts, stores error.
 * If max attempts exceeded, moves to DLQ and removes from queue.
 * Otherwise updates the job with error info for retry.
 */
export async function fail<T extends QueueJob>(
	kv: KVNamespace,
	queueKey: string,
	url: string,
	error: string,
	maxAttempts: number,
	dlqPrefix: string
): Promise<void> {
	const urlHash = hashUrl(url);
	const processingKey = PROCESSING_PREFIX + urlHash;

	// Get current job
	const raw = await kv.get(queueKey);
	if (!raw) {
		// Job disappeared, just release claim
		await kv.delete(processingKey);
		return;
	}

	const job = JSON.parse(raw) as T;
	job.attempts += 1;
	job.lastAttempt = new Date().toISOString();
	job.error = error;

	if (job.attempts >= maxAttempts) {
		// Move to DLQ
		const dlqKey = dlqPrefix + urlHash;
		const dlqEntry = {
			job,
			failedAt: new Date().toISOString(),
			attempts: job.attempts,
			lastError: error,
		};

		await Promise.all([
			kv.put(dlqKey, JSON.stringify(dlqEntry), {
				expirationTtl: Duration.fromObject({ days: DLQ_TTL_DAYS }).as('seconds'),
			}),
			kv.delete(queueKey),
			kv.delete(processingKey),
		]);

		console.error(`Job moved to DLQ after ${job.attempts} attempts:`, url, error);
	} else {
		// Update job with error info and release claim for retry
		await Promise.all([
			kv.put(queueKey, JSON.stringify(job), {
				expirationTtl: Duration.fromObject({ days: QUEUE_TTL_DAYS }).as('seconds'),
			}),
			kv.delete(processingKey),
		]);

		console.warn(`Job failed (attempt ${job.attempts}/${maxAttempts}):`, url, error);
	}
}

/**
 * Get a job from the queue (for inspection/debugging).
 */
export async function getJob<T>(kv: KVNamespace, queueKey: string): Promise<T | null> {
	const raw = await kv.get(queueKey);
	if (!raw) return null;
	return JSON.parse(raw) as T;
}
