export interface Opportunity {
  title: string;
  link: string;
  identifier: string | null;
  announcementType: string | null;
  status: string | null;
  opening: string | null;
  deadline: string | null;
  programmeName: string | null;
  actionType: string | null;
  stage: string | null;
  summary?: string;
}

export interface SummarizeOptions {
  force?: boolean;
  limit?: number;
  model?: string;
  target?: string;
  browserPage?: any; // Puppeteer Page (Cloudflare variant)
}

export interface SummarizeJob {
  url: string;
  opportunity: Opportunity;
  enqueued: string;
  attempts: number;
  lastAttempt?: string;
  error?: string;
}

export interface NotifyJob {
  opportunity: Opportunity;
  summarized: string;
  attempts: number;
  lastAttempt?: string;
  error?: string;
}

export interface Env {
  BROWSER?: any; // Puppeteer launch binding
  SUMMARIES?: KVNamespace;
  AI?: any; // Workers AI binding
  SUMMARY_MODEL?: string;

  // New Discord integration
  DISCORD_WEBHOOK_URL?: string;

  // Queue configuration
  CRAWLER_BATCH_SIZE?: string;
  SUMMARIZER_BATCH_SIZE?: string;
  NOTIFIER_BATCH_SIZE?: string;
  MAX_SUMMARIZE_ATTEMPTS?: string;
  MAX_NOTIFY_ATTEMPTS?: string;
}
