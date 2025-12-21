import type { Opportunity } from '../types';

export interface DiscordEmbed {
	title: string;
	description: string;
	url: string;
	color: number;
	timestamp: string;
	fields: Array<{
		name: string;
		value: string;
		inline: boolean;
	}>;
	footer: {
		text: string;
	};
}

export interface DiscordWebhookPayload {
	embeds: DiscordEmbed[];
}

const STATUS_COLORS: Record<string, number> = {
	Open: 0x2ecc71, // Green
	'Open For Submission': 0x2ecc71,
	Forthcoming: 0x3498db, // Blue
	Closed: 0x95a5a6, // Gray
	Cancelled: 0xe74c3c, // Red
	Suspended: 0xf39c12, // Orange
};

const DEFAULT_COLOR = 0x9b59b6; // Purple

/**
 * Create a Discord embed from an opportunity.
 */
export function createEmbed(opportunity: Opportunity): DiscordEmbed {
	const fields: Array<{ name: string; value: string; inline: boolean }> = [];

	if (opportunity.identifier) {
		fields.push({ name: 'Identifier', value: opportunity.identifier, inline: true });
	}

	if (opportunity.status) {
		fields.push({ name: 'Status', value: opportunity.status, inline: true });
	}

	if (opportunity.announcementType) {
		fields.push({ name: 'Type', value: opportunity.announcementType, inline: true });
	}

	if (opportunity.opening) {
		fields.push({ name: 'Opening Date', value: opportunity.opening, inline: true });
	}

	if (opportunity.deadline) {
		fields.push({ name: 'Deadline', value: opportunity.deadline, inline: true });
	}

	if (opportunity.stage) {
		fields.push({ name: 'Stage', value: opportunity.stage, inline: true });
	}

	if (opportunity.programmeName) {
		fields.push({ name: 'Programme', value: opportunity.programmeName, inline: false });
	}

	if (opportunity.actionType) {
		fields.push({ name: 'Action Type', value: opportunity.actionType, inline: false });
	}

	// Determine color based on status
	const color = opportunity.status ? STATUS_COLORS[opportunity.status] || DEFAULT_COLOR : DEFAULT_COLOR;

	// Use summary as description if available, otherwise use a placeholder
	const description = opportunity.summary || 'No summary available yet.';

	return {
		title: opportunity.title,
		description,
		url: opportunity.link,
		color,
		timestamp: new Date().toISOString(),
		fields,
		footer: {
			text: 'EU Fund Tracker • Powered by Cloudflare Workers',
		},
	};
}

/**
 * Post an embed to a Discord webhook.
 * Throws on error with details for retry handling.
 */
export async function postToWebhook(webhookUrl: string, embed: DiscordEmbed): Promise<void> {
	const payload: DiscordWebhookPayload = {
		embeds: [embed],
	};

	const response = await fetch(webhookUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(payload),
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => 'Unknown error');

		// Handle rate limiting specially
		if (response.status === 429) {
			const retryAfter = response.headers.get('retry-after');
			throw new Error(`Discord rate limit: retry after ${retryAfter || 'unknown'}s`);
		}

		throw new Error(`Discord webhook failed (${response.status}): ${errorText}`);
	}
}

/**
 * Post an opportunity to Discord webhook.
 * Convenience wrapper that creates embed and posts.
 */
export async function postOpportunity(webhookUrl: string, opportunity: Opportunity): Promise<void> {
	const embed = createEmbed(opportunity);
	await postToWebhook(webhookUrl, embed);
}
