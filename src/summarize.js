// Summarization module.
// Strategy (in order):
// 1. If Workers AI binding (env.AI) is available, attempt to generate an abstractive summary
//    with a configurable model (default: @cf/meta/llama-3.1-8b-instruct).
// 2. Fallback to heuristic first-N-words summarizer if AI not available or errors.
// 3. Cache in KV (14d TTL) keyed by identifier (or link) unless force refresh.
//
// You can override model by setting a secret/var SUMMARY_MODEL or via query param in future.
// To add OpenAI (ChatGPT) instead, you could store OPENAI_API_KEY secret and implement a
// fetch call (not included here to avoid external dependency by default).

import { parseHTML } from 'linkedom';

/**
 * Heuristic summarizer: returns the first ~40 words of body stripping whitespace.
 */
function naiveSummarize(text, maxWords = 60) {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  return words.slice(0, maxWords).join(' ') + (words.length > maxWords ? '…' : '');
}

/**
 * Lightweight HTML -> Markdown-ish conversion using linkedom (already in project) to avoid
 * pulling a heavier dependency. We keep only semantic blocks we care about for summarization.
 */
function htmlToMarkdown(html) {
  try {
    const { document } = parseHTML(html);
    // Remove noise nodes early
    document.querySelectorAll('script,style,noscript,template').forEach(n => n.remove());

    const lines = [];
    const push = txt => { const t = txt.replace(/\s+/g, ' ').trim(); if (t) lines.push(t); };

    function nodeText(node) {
      if (!node) return '';
      if (node.nodeType === 3) return node.textContent || '';
      if (node.nodeType !== 1) return '';
      const tag = node.tagName?.toLowerCase();
      if (tag === 'br') return '\n';
      let out = '';
      for (const child of node.childNodes) out += nodeText(child);
      if (/^(p|div)$/i.test(tag)) out = out + '\n\n';
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
    for (const child of root.childNodes) {
      acc += nodeText(child);
    }
    // Normalize blank lines
    acc = acc.split(/\n{3,}/).join('\n\n');
    return acc.trim();
  } catch (e) {
    // Fallback simple strip
    return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
  }
}

/**
 * Attempt to fetch article HTML and return a short summary.
 * We keep it minimal to stay within Worker limits.
 */
export async function summarizeLink(url, { fetchImpl = fetch, env, modelOverride, browserPage } = {}) {
  try {
    let html;
    if (browserPage) {
      try {
        await browserPage.setUserAgent('Mozilla/5.0 (compatible; WorkersScraper/1.0)');
      } catch { }
      await browserPage.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
      html = await browserPage.content();
    } else {
      const res = await fetchImpl(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Summarizer/1.0)' } });
      if (!res.ok) return null;
      html = await res.text();
    }
    const markdown = htmlToMarkdown(html);

    // Attempt Workers AI summarization if binding present.
    console.log(`Summarizing ${url}`);
    if (env?.AI) {
      const model = modelOverride || env.SUMMARY_MODEL || '@cf/meta/llama-3.1-8b-instruct';
      console.log(`Using model ${model}`);
      const snippet = markdown.slice(0, 5000);
      const prompt = `
        Summarize the following EU funding call description in <= 100 words in a single paragraph.
        Include key points like what the funding is for, who can apply,
        how much can be requested, and any specific requirements.
        Plain concise English, no intro labels, no marketing fluff, form regular sentences.
        You can use Markdown formatting for emphasis and structure where needed.
        \n\n"""${snippet}"""`;
      try {
        const aiResp = await env.AI.run(model, {
          messages: [
            { role: 'system', content: 'You generate concise neutral summaries of EU funding call descriptions.' },
            { role: 'user', content: prompt }
          ]
        });
        const aiText = aiResp?.response || aiResp?.result || aiResp?.text || null;
        if (aiText) {
          console.log(`Got summary from AI: ${aiText}`);
          // Basic post-trim & collapse whitespace
          return aiText.replace(/\s+/g, ' ').trim().replace(/^"|"$/g, '');
        }
      } catch (aiErr) {
        // Silently fallback
      }
    }

    return naiveSummarize(candidate);
  } catch (_) {
    return null;
  }
}

/**
 * Fill summaries for items, using KV or Durable cache where provided.
 * @param {Array} items
 * @param {*} env expects `SUMMARIES` KV namespace (optional)
 * @param {Object} options
 *   - force: if true, ignore cache and re-summarize
 *   - limit: max number of new summaries per invocation (default 5 to control cost)
 */
export async function enrichWithSummaries(items, env, { force = false, limit = 5, model, target, browserPage } = {}) {
  if (!items.length) return items;
  const kv = env?.SUMMARIES; // Cloudflare KV binding (must be added in wrangler.jsonc)
  let newCount = 0;
  for (const item of items) {
    const url = new URL(item.link, target).toString();
    console.log('Processing item for summary', url);
    if (!force && kv) {
      try {
        const cached = await kv.get(url);
        if (cached) {
          item.summary = cached;
          continue;
        }
      } catch (_) { }
    }
    if (newCount >= limit) continue; // budget control
    const summary = await summarizeLink(url, { env, modelOverride: model, browserPage });
    if (summary) {
      item.summary = summary;
      if (kv) {
        try { await kv.put(url, summary, { expirationTtl: 60 * 60 * 24 * 14 }); } catch (_) { }
      }
      newCount++;
    }
  }
  return items;
}
