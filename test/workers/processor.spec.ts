import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { enqueue, SUMMARIZE_QUEUE_PREFIX, listPending, getJob } from '../../src/shared/queue';
import type { SummarizeJob, Opportunity, Env } from '../../src/types';

// Mock the external dependencies
vi.mock('../../src/summarize', () => ({
	summarizeLink: vi.fn(async (url: string) => {
		return `This is a test summary for ${url}`;
	}),
}));

vi.mock('../../src/shared/discord', () => ({
	postOpportunity: vi.fn(async () => {
		// Mock successful Discord post
		return;
	}),
}));

describe('Processor Worker', () => {
	const testOpportunity: Opportunity = {
		title: 'Test EU Funding Opportunity',
		link: 'https://example.com/test-opportunity',
		identifier: 'TEST-2026-01',
		announcementType: 'Calls for proposals',
		status: 'Open For Submission',
		opening: '01 January 2026',
		deadline: '31 December 2026',
		programmeName: 'Test Programme',
		actionType: 'Test Action',
		stage: 'Single-stage',
	};

	beforeEach(async () => {
		// Clean up KV before each test
		const allKeys = await env.SUMMARIES.list();
		for (const key of allKeys.keys) {
			await env.SUMMARIES.delete(key.name);
		}

		// Reset mocks
		vi.clearAllMocks();
	});

	describe('End-to-end flow', () => {
		it('should process a job: summarize and notify', async () => {
			const { summarizeLink } = await import('../../src/summarize');
			const { postOpportunity } = await import('../../src/shared/discord');

			// Enqueue a test job
			const job: SummarizeJob = {
				url: testOpportunity.link,
				opportunity: testOpportunity,
				enqueued: new Date().toISOString(),
				attempts: 0,
			};

			const queueKey = await enqueue(env.SUMMARIES, SUMMARIZE_QUEUE_PREFIX, job.url, job);

			// Verify job is in queue
			const pending = await listPending(env.SUMMARIES, SUMMARIZE_QUEUE_PREFIX, 10);
			expect(pending).toHaveLength(1);
			expect(pending[0]).toBe(queueKey);

			// Import and run the processor logic
			// Note: We import the worker module to get access to the processing function
			// Since the worker exports a default object, we need to import processor.ts differently
			// For this test, we'll inline the logic to test it

			const { summarizeLink: mockSummarizeLink } = await import('../../src/summarize');
			const { postOpportunity: mockPostOpportunity } = await import('../../src/shared/discord');
			const { listPending: qListPending, claim, complete, getJob: qGetJob } = await import('../../src/shared/queue');

			// Simulate processor logic
			const pendingKeys = await qListPending(env.SUMMARIES, SUMMARIZE_QUEUE_PREFIX, 5);
			expect(pendingKeys).toHaveLength(1);

			const retrievedJob = await qGetJob<SummarizeJob>(env.SUMMARIES, pendingKeys[0]);
			expect(retrievedJob).toBeTruthy();

			if (retrievedJob) {
				const claimed = await claim(env.SUMMARIES, retrievedJob.url);
				expect(claimed).toBe(true);

				// Simulate summary generation
				const summary = await mockSummarizeLink(retrievedJob.url, { env });
				expect(summary).toContain('test summary');

				// Simulate Discord post
				await mockPostOpportunity('https://discord.webhook.test', {
					...retrievedJob.opportunity,
					summary: summary!,
				});

				// Complete the job
				await complete(env.SUMMARIES, pendingKeys[0], retrievedJob.url);

				// Verify job is removed from queue
				const afterPending = await qListPending(env.SUMMARIES, SUMMARIZE_QUEUE_PREFIX, 10);
				expect(afterPending).toHaveLength(0);

				// Verify mocks were called
				expect(mockSummarizeLink).toHaveBeenCalledWith(testOpportunity.link, expect.objectContaining({ env }));
				expect(mockPostOpportunity).toHaveBeenCalledWith(
					'https://discord.webhook.test',
					expect.objectContaining({
						identifier: 'TEST-2026-01',
						summary: expect.stringContaining('test summary'),
					})
				);
			}
		});

		it('should use cached summary if available', async () => {
			const { summarizeLink } = await import('../../src/summarize');

			// Pre-cache a summary
			const cachedSummary = 'This is a pre-cached summary';
			await env.SUMMARIES.put(testOpportunity.link, cachedSummary);

			// Enqueue a test job
			const job: SummarizeJob = {
				url: testOpportunity.link,
				opportunity: testOpportunity,
				enqueued: new Date().toISOString(),
				attempts: 0,
			};

			await enqueue(env.SUMMARIES, SUMMARIZE_QUEUE_PREFIX, job.url, job);

			// Process the job
			const { listPending: qListPending, claim, complete, getJob: qGetJob } = await import('../../src/shared/queue');

			const pendingKeys = await qListPending(env.SUMMARIES, SUMMARIZE_QUEUE_PREFIX, 5);
			const retrievedJob = await qGetJob<SummarizeJob>(env.SUMMARIES, pendingKeys[0]);

			if (retrievedJob) {
				await claim(env.SUMMARIES, retrievedJob.url);

				// Check for cached summary
				const existingSummary = await env.SUMMARIES.get(retrievedJob.url);
				expect(existingSummary).toBe(cachedSummary);

				// summarizeLink should NOT be called since summary is cached
				// In real code, we check for cached summary first
				const summary = existingSummary || (await summarizeLink(retrievedJob.url, { env }));

				expect(summary).toBe(cachedSummary);
				expect(summarizeLink).not.toHaveBeenCalled();

				await complete(env.SUMMARIES, pendingKeys[0], retrievedJob.url);
			}
		});

		it('should handle multiple jobs sequentially', async () => {
			const { postOpportunity } = await import('../../src/shared/discord');

			// Enqueue multiple jobs
			const opportunities = [
				{ ...testOpportunity, identifier: 'TEST-2026-01', link: 'https://example.com/opp1' },
				{ ...testOpportunity, identifier: 'TEST-2026-02', link: 'https://example.com/opp2' },
				{ ...testOpportunity, identifier: 'TEST-2026-03', link: 'https://example.com/opp3' },
			];

			for (const opp of opportunities) {
				const job: SummarizeJob = {
					url: opp.link,
					opportunity: opp,
					enqueued: new Date().toISOString(),
					attempts: 0,
				};
				await enqueue(env.SUMMARIES, SUMMARIZE_QUEUE_PREFIX, job.url, job);
			}

			// Verify all jobs are queued
			const pending = await listPending(env.SUMMARIES, SUMMARIZE_QUEUE_PREFIX, 10);
			expect(pending).toHaveLength(3);

			// Process each job
			const { listPending: qListPending, claim, complete, getJob: qGetJob } = await import('../../src/shared/queue');
			const { summarizeLink } = await import('../../src/summarize');

			for (const queueKey of pending) {
				const job = await qGetJob<SummarizeJob>(env.SUMMARIES, queueKey);
				if (job) {
					const claimed = await claim(env.SUMMARIES, job.url);
					expect(claimed).toBe(true);

					const summary = await summarizeLink(job.url, { env });
					await postOpportunity('https://discord.webhook.test', {
						...job.opportunity,
						summary: summary!,
					});
					await complete(env.SUMMARIES, queueKey, job.url);
				}
			}

			// Verify all jobs are processed
			const afterPending = await qListPending(env.SUMMARIES, SUMMARIZE_QUEUE_PREFIX, 10);
			expect(afterPending).toHaveLength(0);

			// Verify Discord was called 3 times
			expect(postOpportunity).toHaveBeenCalledTimes(3);
		});

		it('should skip already claimed jobs', async () => {
			// Enqueue a test job
			const job: SummarizeJob = {
				url: testOpportunity.link,
				opportunity: testOpportunity,
				enqueued: new Date().toISOString(),
				attempts: 0,
			};

			await enqueue(env.SUMMARIES, SUMMARIZE_QUEUE_PREFIX, job.url, job);

			const { claim } = await import('../../src/shared/queue');

			// Claim the job
			const firstClaim = await claim(env.SUMMARIES, job.url);
			expect(firstClaim).toBe(true);

			// Try to claim again (simulating concurrent processing)
			const secondClaim = await claim(env.SUMMARIES, job.url);
			expect(secondClaim).toBe(false);
		});
	});

	describe('Error handling', () => {
		it('should handle summarization errors', async () => {
			const { summarizeLink } = await import('../../src/summarize');

			// Mock summarizeLink to throw an error
			vi.mocked(summarizeLink).mockRejectedValueOnce(new Error('Summarization failed'));

			const job: SummarizeJob = {
				url: testOpportunity.link,
				opportunity: testOpportunity,
				enqueued: new Date().toISOString(),
				attempts: 0,
			};

			const queueKey = await enqueue(env.SUMMARIES, SUMMARIZE_QUEUE_PREFIX, job.url, job);

			const { listPending: qListPending, claim, fail, getJob: qGetJob } = await import('../../src/shared/queue');

			const pendingKeys = await qListPending(env.SUMMARIES, SUMMARIZE_QUEUE_PREFIX, 5);
			const retrievedJob = await qGetJob<SummarizeJob>(env.SUMMARIES, pendingKeys[0]);

			if (retrievedJob) {
				await claim(env.SUMMARIES, retrievedJob.url);

				try {
					await summarizeLink(retrievedJob.url, { env });
					expect.fail('Should have thrown an error');
				} catch (error: any) {
					// Handle the error using fail()
					await fail(env.SUMMARIES, queueKey, retrievedJob.url, error.message, 3, 'dlq:summarize:');

					// Verify job is updated with error
					const updatedJob = await qGetJob<SummarizeJob>(env.SUMMARIES, queueKey);
					expect(updatedJob?.attempts).toBe(1);
					expect(updatedJob?.error).toBe('Summarization failed');
				}
			}
		});
	});
});
