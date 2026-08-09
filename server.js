const express = require('express');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const { marked } = require('marked');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const JINA_API_KEY = process.env.JINA_API_KEY || '';

// Load BPC rules if available
let bpcRules = { domains: [], archiveDomains: [], sitesMap: {} };
const rulesPath = path.join(__dirname, 'bpc-rules.json');
if (fs.existsSync(rulesPath)) {
  try {
    bpcRules = JSON.parse(fs.readFileSync(rulesPath, 'utf-8'));
  } catch (err) {
    console.error('Failed to parse bpc-rules.json:', err.message);
  }
}

/**
 * Combines a parent AbortSignal with a strict timeout signal.
 */
function getCombinedSignal(timeoutMs, parentSignal) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);

  const onParentAbort = () => {
    clearTimeout(timeoutId);
    controller.abort(parentSignal.reason || new Error('Parent aborted'));
  };

  if (parentSignal) {
    if (parentSignal.aborted) {
      onParentAbort();
    } else {
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
  }

  return controller.signal;
}

/**
 * Sanitizes input URLs.
 */
function sanitizeUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * Constructs headers for Jina Reader API requests.
 */
function getJinaHeaders() {
  const headers = { 'Accept': 'application/json' };
  if (JINA_API_KEY) headers['Authorization'] = `Bearer ${JINA_API_KEY}`;
  return headers;
}

/**
 * Verifies if extracted HTML contains valid text content.
 */
function isValidContent(htmlStr) {
  if (!htmlStr || typeof htmlStr !== 'string') return false;
  const dom = new JSDOM(htmlStr);
  const text = dom.window.document.body.textContent || '';
  return text.trim().length > 200;
}

/**
 * Generates formatted HTML output optimized for Kindle devices.
 */
function buildKindleHTML(title, bodyHtml, sourceUrl, stripImages = false) {
  const dom = new JSDOM(bodyHtml);
  const doc = dom.window.document;

  if (stripImages) {
    doc.querySelectorAll('img, picture, figure, svg').forEach(el => el.remove());
  }

  const cleanBody = doc.body.innerHTML;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body { font-family: serif; line-height: 1.5; margin: 1em; padding: 0; }
    h1 { font-size: 1.8em; margin-bottom: 0.5em; }
    a.source-link { font-size: 0.85em; color: #555; text-decoration: none; display: block; margin-bottom: 1.5em; }
    img { max-width: 100%; height: auto; display: block; margin: 1em auto; }
    p { margin-bottom: 1em; text-align: justify; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <a class="source-link" href="${sourceUrl}">Source: ${sourceUrl}</a>
  <hr/>
  <main>${cleanBody}</main>
</body>
</html>`;
}

/**
 * Tier 1: Direct extraction via Jina AI Reader API.
 */
async function fetchViaJinaDirect(targetUrl, parentSignal, stripImages = false) {
  const endpoint = `https://r.jina.ai/${targetUrl}`;
  const response = await fetch(endpoint, {
    headers: getJinaHeaders(),
    signal: getCombinedSignal(8000, parentSignal)
  });

  if (!response.ok) throw new Error(`Jina Direct HTTP ${response.status}`);

  const json = await response.json();
  if (!json.data || !json.data.content) throw new Error('Jina payload empty');

  const htmlContent = await marked.parse(json.data.content);
  if (!isValidContent(htmlContent)) throw new Error('Jina extracted insufficient content');

  return buildKindleHTML(json.data.title || 'Extracted Article', htmlContent, targetUrl, stripImages);
}

/**
 * Tier 2: Direct site scrape processed with Mozilla Readability.
 */
async function fetchViaScrapeReadability(targetUrl, parentSignal, stripImages = false) {
  const response = await fetch(targetUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
    },
    signal: getCombinedSignal(8000, parentSignal)
  });

  if (!response.ok) throw new Error(`Direct scrape HTTP ${response.status}`);

  const htmlText = await response.text();
  const dom = new JSDOM(htmlText, { url: targetUrl });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article || !isValidContent(article.content)) {
    throw new Error('Readability failed to parse valid article body');
  }

  return buildKindleHTML(article.title || 'Extracted Article', article.content, targetUrl, stripImages);
}

/**
 * Tier 3: Snapshot extraction via archive.ph routed through Jina AI Reader API.
 */
async function fetchViaArchivePh(targetUrl, parentSignal, stripImages = false) {
  const archivePhUrl = `https://archive.ph/newest/${encodeURIComponent(targetUrl)}`;
  const response = await fetch(`https://r.jina.ai/${archivePhUrl}`, {
    headers: getJinaHeaders(),
    signal: getCombinedSignal(10000, parentSignal)
  });

  if (!response.ok) throw new Error(`archive.ph HTTP ${response.status}`);

  const json = await response.json();
  if (!json.data || !json.data.content) throw new Error('archive.ph payload empty');

  const htmlContent = await marked.parse(json.data.content);
  if (!isValidContent(htmlContent)) throw new Error('archive.ph snapshot missing or blocked');

  return buildKindleHTML(json.data.title || 'Archived Article', htmlContent, targetUrl, stripImages);
}

/**
 * Pipeline execution controller routing through extraction tiers.
 */
async function executePipeline(targetUrl, parentSignal, stripImages = false, debug = false) {
  const parsed = new URL(targetUrl);
  const hostname = parsed.hostname.replace(/^www\./, '');

  const isArchiveFirst = bpcRules.archiveDomains.some(domain => hostname.endsWith(domain));

  if (isArchiveFirst) {
    if (debug) console.log(`[PIPELINE] Routing directly to Tier 3 (archive.ph) for domain: ${hostname}`);
    try {
      return await fetchViaArchivePh(targetUrl, parentSignal, stripImages);
    } catch (err) {
      if (debug) console.warn(`[PIPELINE] Tier 3 (archive.ph) failed: ${err.message}. Falling back to Tier 1.`);
    }
  }

  // Tier 1 execution
  try {
    if (debug) console.log(`[PIPELINE] Executing Tier 1 (Jina Direct) for URL: ${targetUrl}`);
    return await fetchViaJinaDirect(targetUrl, parentSignal, stripImages);
  } catch (err) {
    if (debug) console.warn(`[PIPELINE] Tier 1 failed: ${err.message}`);
  }

  // Tier 2 execution
  try {
    if (debug) console.log(`[PIPELINE] Executing Tier 2 (Scrape + Readability) for URL: ${targetUrl}`);
    return await fetchViaScrapeReadability(targetUrl, parentSignal, stripImages);
  } catch (err) {
    if (debug) console.warn(`[PIPELINE] Tier 2 failed: ${err.message}`);
  }

  // Tier 3 fallback (if not already executed first)
  if (!isArchiveFirst) {
    try {
      if (debug) console.log(`[PIPELINE] Executing Tier 3 (archive.ph) for URL: ${targetUrl}`);
      return await fetchViaArchivePh(targetUrl, parentSignal, stripImages);
    } catch (err) {
      if (debug) console.warn(`[PIPELINE] Tier 3 failed: ${err.message}`);
    }
  }

  throw new Error('All extraction tiers failed to produce valid content');
}

/**
 * Express endpoint handler for article extraction.
 */
app.get('/extract', async (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');

  const rawUrl = req.query.url;
  if (!rawUrl) return res.status(400).send('Missing url parameter');

  const targetUrl = sanitizeUrl(rawUrl);
  if (!targetUrl) return res.status(400).send('Invalid URL provided.');

  const stripImages = req.query.no_images === 'true' || req.query.no_images === '1';
  const debug = req.query.debug === 'true' || req.query.debug === '1';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const result = await executePipeline(targetUrl, controller.signal, stripImages, debug);
    return res.send(result);
  } catch (err) {
    if (debug) {
      console.error(`[EXTRACTION FAILED] Domain: ${targetUrl} | Reason: ${err.message}`);
    }
    if (controller.signal.aborted) {
      return res.status(504).send('Extraction timed out.');
    }
    return res.status(500).send('Failed to extract content across all tiers.');
  } finally {
    clearTimeout(timeout);
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
