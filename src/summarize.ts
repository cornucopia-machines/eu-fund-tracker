import { parseHTML } from 'linkedom';
import type { Opportunity, Env, SummarizeOptions } from './types';
import { Duration } from "luxon";
import dedent from 'dedent';

/**
 * Heuristic summarizer: returns the first ~40 words of body stripping whitespace.
 */
function naiveSummarize(text: string, maxWords = 60): string {
	const words = text.replace(/\s+/g, ' ').trim().split(' ');
	return words.slice(0, maxWords).join(' ') + (words.length > maxWords ? '…' : '');
}

/**
 * Lightweight HTML -> Markdown-ish conversion using linkedom (already in project) to avoid
 * pulling a heavier dependency. We keep only semantic blocks we care about for summarization.
 */
function htmlToMarkdown(html: string): string {
	try {
		const { document } = parseHTML(html);
		// Remove noise nodes early
		document.querySelectorAll('script,style,noscript,template').forEach((n: any) => n.remove());

		function nodeText(node: any): string {
			if (!node) return '';
			if (node.nodeType === 3) return node.textContent || '';
			if (node.nodeType !== 1) return '';
			const tag = node.tagName?.toLowerCase();
			if (tag === 'br') return '\n';
			let out = '';
			for (const child of node.childNodes) out += nodeText(child);
			if (/^(p|div)$/i.test(tag)) out += '\n\n';
			if (/^h[1-6]$/.test(tag)) {
				const level = Number(tag[1]);
				out = `${'#'.repeat(Math.min(level, 6))} ${out.trim()}\n\n`;
			}
			if (tag === 'li') out = `- ${out.trim()}\n`;
			if (tag === 'a') {
				const href = node.getAttribute('href');
				const text = out.trim();
				if (href && text) return `[${text}](${href})`;
			}
			return out;
		}

		// Prefer main/container semantics if present
		const root = document.querySelector('main, article, .content, #content') || document.body;
		if (!root) return html.replace(/<[^>]+>/g, ' ');
		let acc = '';
		for (const child of (root as any).childNodes) acc += nodeText(child);
		// Normalize blank lines
		acc = acc.split(/\n{3,}/).join('\n\n');
		return acc.trim();
	} catch {
		// Fallback simple strip
		return html
			.replace(/<script[\s\S]*?<\/script>/gi, ' ')
			.replace(/<style[\s\S]*?<\/style>/gi, ' ')
			.replace(/<[^>]+>/g, ' ');
	}
}

/**
 * Attempt to fetch article HTML and return a short summary.
 * We keep it minimal to stay within Worker limits.
 */
export async function summarizeLink(
	url: string,
	{ fetchImpl = fetch, env, modelOverride, browserPage }: { fetchImpl?: typeof fetch; env: Env; modelOverride?: string; browserPage?: any }
) {
  console.log(`Summarizing ${url}`);
  let html: string;
  if (browserPage) {
    await browserPage.setUserAgent('Mozilla/5.0 (compatible; WorkersScraper/1.0)');
    await browserPage.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
    html = await browserPage.content();
  } else {
    const res = await fetchImpl(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Summarizer/1.0)' } });
    if (!res.ok) return null;
    html = await res.text();
  }
  const markdown = htmlToMarkdown(html);

  // Attempt Workers AI summarization if binding present.
  if (env?.AI) {
    const model = modelOverride || env.SUMMARY_MODEL || '@cf/meta/llama-3.1-8b-instruct';
    const snippet = markdown.slice(0, 5000);
    const prompt = dedent`
      Summarize the following EU funding call description in <= 100 words in a single paragraph.
      Include key points like what the funding is for, who can apply,
      how much can be requested, and any specific requirements.

      In a second paragraph give a score between 0-100 for how well the call fits my project 'GrowMachine':

      '''
      GrowMachine is a smart IoT irrigation product for home gardeners and small farms that helps users
      grow their own food without much knowledge of farming.
      It is published as open source hardware and software under the OCL license.
      '''

      Give a higher score if the call is specifically related to sustainable agriculture, smart farming,
      IoT devices, and accepts applications from small businesses or startups that are yet to go to market.
      Give a lower score if the call is specific to a certain technology or area that is not relevant to my project
      (e.g., blockchain, network security, satellite communications, improving democracy, etc.).
      The score should be relevant to how likely my project is to receive funding from this specific call, not
      a general assessment of EU funding programs.
      State the score and explain your reasoning briefly without describing my project.

      Use plain concise English, no intro labels, no marketing fluff, form regular sentences.
      You can use Markdown formatting for emphasis and structure where needed, especially to highlight data points in the text.
      \n\n"""${snippet}"""
    `;
      const aiResp = await env.AI.run(model, {
        messages: [
          { role: 'system', content: 'You generate concise neutral summaries of EU funding call descriptions.' },
          { role: 'user', content: prompt },
        ],
      });
      const aiText: string | undefined = aiResp?.response || aiResp?.result || aiResp?.text;
      if (aiText) {
        console.log(`Got summary from AI: ${aiText}`);
        return aiText;
      } else {
        throw new Error('No text in AI response');
      }
  }
}

export async function enrichWithSummaries(items: Opportunity[], env: Env, opts: SummarizeOptions = {}): Promise<Opportunity[]> {
	const { force = false, limit = 10, model, target, browserPage } = opts;
	if (!items.length) return items;
	const kv = env?.SUMMARIES;
	let newCount = 0;
	for (const item of items) {
		if (item.summary) continue;
		const url = target ? new URL(item.link, target).toString() : item.link;
		if (!force && kv) {
      const cached = await kv.get(url);
      if (cached) {
        console.log(`Using cached summary for ${url}`);
        item.summary = cached;
        continue;
      }
		}
		if (newCount >= limit) {
      console.log(`New summary limit of ${limit} reached, skipping further summaries`);
      continue;
    }
		const summary = await summarizeLink(url, { env, modelOverride: model, browserPage });
		if (summary) {
			item.summary = summary;
			if (kv) {
        await kv.put(url, summary, { expirationTtl: Duration.fromObject({ weeks: 2 }).as('seconds') });
			}
			newCount++;
		} else {
      console.error(`Failed to generate summary for ${url}`);
    }
	}
	return items;
}
