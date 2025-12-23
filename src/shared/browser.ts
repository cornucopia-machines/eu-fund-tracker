import { Env } from '../types';

export async function createPageWithBrowserIfNeeded(env: Env): Promise<{ page: any; browser: any }> {
  if (!env.BROWSER) {
    return { page: null, browser: null };
  }
  const puppeteer: any = await import('@cloudflare/puppeteer');
  const browser = await puppeteer.launch(env.BROWSER);
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (compatible; WorkersScraper/1.0)');
  return { page, browser };
}
