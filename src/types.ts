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

export interface Env {
  BROWSER?: any; // Puppeteer launch binding
  SUMMARIES?: KVNamespace;
  AI?: any; // Workers AI binding
  SUMMARY_MODEL?: string;
}
