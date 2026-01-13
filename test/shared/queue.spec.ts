import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	enqueue,
	listPending,
	claim,
	release,
	complete,
	fail,
	getJob,
	SUMMARIZE_QUEUE_PREFIX,
	PROCESSING_PREFIX,
	DLQ_SUMMARIZE_PREFIX,
} from '../../src/shared/queue';

interface TestJob {
	data: string;
	attempts: number;
	lastAttempt?: string;
	error?: string;
}

describe('Queue Operations', () => {
	const testUrl = 'https://example.com/test-opportunity';

	beforeEach(async () => {
		// Clean up KV before each test
		const prefixes = [SUMMARIZE_QUEUE_PREFIX, PROCESSING_PREFIX, DLQ_SUMMARIZE_PREFIX];
		for (const prefix of prefixes) {
			const keys = await env.SUMMARIES.list({ prefix });
			for (const key of keys.keys) {
				await env.SUMMARIES.delete(key.name);
			}
		}
	});

	describe('enqueue', () => {
		it('should enqueue a job with timestamp key', async () => {
			const job: TestJob = { data: 'test', attempts: 0 };
			const key = await enqueue(env.SUMMARIES, SUMMARIZE_QUEUE_PREFIX, testUrl, job);

			expect(key).toMatch(/^queue:summarize:\d+:/);

			const stored = await getJob<TestJob>(env.SUMMARIES, key);
			expect(stored).toEqual(job);
		});

		it('should create unique keys for same URL at different times', async () => {
			const job1: TestJob = { data: 'first', attempts: 0 };
			const job2: TestJob = { data: 'second', attempts: 0 };

			const key1 = await enqueue(env.SUMMARIES, SUMMARIZE_QUEUE_PREFIX, testUrl, job1);
			await new Promise((resolve) => setTimeout(resolve, 10)); // Small delay
			const key2 = await enqueue(env.SUMMARIES, SUMMARIZE_QUEUE_PREFIX, testUrl, job2);

			expect(key1).not.toBe(key2);
		});
	});

	describe('listPending', () => {
		it('should list queued jobs in chronological order', async () => {
			const job1: TestJob = { data: 'first', attempts: 0 };
			const job2: TestJob = { data: 'second', attempts: 0 };
			const job3: TestJob = { data: 'third', attempts: 0 };

			const key1 = await enqueue(env.SUMMARIES, SUMMARIZE_QUEUE_PREFIX, testUrl + '/1', job1);
			await new Promise((resolve) => setTimeout(resolve, 10));
			const key2 = await enqueue(env.SUMMARIES, SUMMARIZE_QUEUE_PREFIX, testUrl + '/2', job2);
			await new Promise((resolve) => setTimeout(resolve, 10));
			const key3 = await enqueue(env.SUMMARIES, SUMMARIZE_QUEUE_PREFIX, testUrl + '/3', job3);

			const pending = await listPending(env.SUMMARIES, SUMMARIZE_QUEUE_PREFIX, 10);

			expect(pending).toHaveLength(3);
			expect(pending[0]).toBe(key1);
			expect(pending[1]).toBe(key2);
			expect(pending[2]).toBe(key3);
		});

		it('should respect limit parameter', async () => {
			for (let i = 0; i < 5; i++) {
				await enqueue(env.SUMMARIES, SUMMARIZE_QUEUE_PREFIX, `${testUrl}/${i}`, { data: `job${i}`, attempts: 0 });
			}

			const pending = await listPending(env.SUMMARIES, SUMMARIZE_QUEUE_PREFIX, 3);
			expect(pending).toHaveLength(3);
		});

		it('should return empty array when queue is empty', async () => {
			const pending = await listPending(env.SUMMARIES, SUMMARIZE_QUEUE_PREFIX, 10);
			expect(pending).toEqual([]);
		});
	});

	describe('claim', () => {
		it('should successfully claim an unclaimed job', async () => {
			const claimed = await claim(env.SUMMARIES, testUrl);
			expect(claimed).toBe(true);

			// Verify processing key exists
			const processingKey = PROCESSING_PREFIX + encodeURIComponent(testUrl);
			const value = await env.SUMMARIES.get(processingKey);
			expect(value).toBeTruthy();
		});

		it('should fail to claim an already claimed job', async () => {
			const firstClaim = await claim(env.SUMMARIES, testUrl);
			expect(firstClaim).toBe(true);

			const secondClaim = await claim(env.SUMMARIES, testUrl);
			expect(secondClaim).toBe(false);
		});
	});

	describe('release', () => {
		it('should release a claimed job', async () => {
			await claim(env.SUMMARIES, testUrl);
			await release(env.SUMMARIES, testUrl);

			// Should be able to claim again
			const claimed = await claim(env.SUMMARIES, testUrl);
			expect(claimed).toBe(true);
		});

		it('should be idempotent (no error if not claimed)', async () => {
			await expect(release(env.SUMMARIES, testUrl)).resolves.not.toThrow();
		});
	});

	describe('complete', () => {
		it('should remove both queue item and processing claim', async () => {
			const job: TestJob = { data: 'test', attempts: 0 };
			const queueKey = await enqueue(env.SUMMARIES, SUMMARIZE_QUEUE_PREFIX, testUrl, job);
			await claim(env.SUMMARIES, testUrl);

			await complete(env.SUMMARIES, queueKey, testUrl);

			// Verify both are deleted
			const queueItem = await env.SUMMARIES.get(queueKey);
			expect(queueItem).toBeNull();

			// Should be able to claim again (processing lock released)
			const canClaim = await claim(env.SUMMARIES, testUrl);
			expect(canClaim).toBe(true);
		});
	});

	describe('fail', () => {
		it('should increment attempts and store error', async () => {
			const job: TestJob = { data: 'test', attempts: 0 };
			const queueKey = await enqueue(env.SUMMARIES, SUMMARIZE_QUEUE_PREFIX, testUrl, job);
			await claim(env.SUMMARIES, testUrl);

			await fail(env.SUMMARIES, queueKey, testUrl, 'Test error', 3, DLQ_SUMMARIZE_PREFIX);

			const updated = await getJob<TestJob>(env.SUMMARIES, queueKey);
			expect(updated?.attempts).toBe(1);
			expect(updated?.error).toBe('Test error');
			expect(updated?.lastAttempt).toBeTruthy();

			// Processing claim should be released
			const canClaim = await claim(env.SUMMARIES, testUrl);
			expect(canClaim).toBe(true);
		});

		it('should move to DLQ after max attempts', async () => {
			const job: TestJob = { data: 'test', attempts: 2 }; // Already at 2 attempts
			const queueKey = await enqueue(env.SUMMARIES, SUMMARIZE_QUEUE_PREFIX, testUrl, job);
			await claim(env.SUMMARIES, testUrl);

			await fail(env.SUMMARIES, queueKey, testUrl, 'Final error', 3, DLQ_SUMMARIZE_PREFIX);

			// Job should be removed from queue
			const queueItem = await getJob<TestJob>(env.SUMMARIES, queueKey);
			expect(queueItem).toBeNull();

			// Job should be in DLQ
			const dlqKey = DLQ_SUMMARIZE_PREFIX + encodeURIComponent(testUrl);
			const dlqItem = await env.SUMMARIES.get(dlqKey);
			expect(dlqItem).toBeTruthy();

			const dlqData = JSON.parse(dlqItem!);
			expect(dlqData.attempts).toBe(3);
			expect(dlqData.lastError).toBe('Final error');
		});

		it('should handle missing queue job gracefully', async () => {
			await claim(env.SUMMARIES, testUrl);
			const fakeKey = SUMMARIZE_QUEUE_PREFIX + '123456789:' + encodeURIComponent('https://fake.url');

			await expect(fail(env.SUMMARIES, fakeKey, testUrl, 'Error', 3, DLQ_SUMMARIZE_PREFIX)).resolves.not.toThrow();

			// Processing claim should still be released
			const canClaim = await claim(env.SUMMARIES, testUrl);
			expect(canClaim).toBe(true);
		});
	});

	describe('getJob', () => {
		it('should retrieve a job by queue key', async () => {
			const job: TestJob = { data: 'test data', attempts: 0 };
			const queueKey = await enqueue(env.SUMMARIES, SUMMARIZE_QUEUE_PREFIX, testUrl, job);

			const retrieved = await getJob<TestJob>(env.SUMMARIES, queueKey);
			expect(retrieved).toEqual(job);
		});

		it('should return null for non-existent key', async () => {
			const retrieved = await getJob<TestJob>(env.SUMMARIES, 'nonexistent:key');
			expect(retrieved).toBeNull();
		});
	});
});
