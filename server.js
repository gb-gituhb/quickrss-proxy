const express = require('express');
const { Readability } = require('@mozilla/readability');
const { parseHTML } = require('linkedom');
const { marked } = require('marked');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JINA_API_KEY = process.env.JINA_API_KEY || '';
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';

// Load BPC rules compiled from bpc-extension/sites.js
const rulesPath = path.join(__dirname, 'bpc-rules.json');
let bpcRules = { sitesMap: {}, domains: [], archiveDomains: [] };
if (fs.existsSync(rulesPath)) {
  try {
    bpcRules = JSON.parse(fs.readFileSync(rulesPath, 'utf-8'));
    console.log(`[BPC LAYER 1] Loaded ${bpcRules.domains.length} rule entries.`);
  } catch (err) {
    console.warn('[BPC LAYER 1] Warning: Failed to parse bpc-rules.json');
  }
}

// ==========================================
// IN-MEMORY LRU CACHE
// ==========================================

class SimpleLRUCache {
  constructor(limit = 200, ttlMs = 60 * 60 * 1000) {
    this.limit = limit;
    this.ttlMs = ttlMs;
    this.cache = new Map();
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    this.cache.delete(key);
    this.cache.set(key, item);
    return item.value;
  }

  set(key, value) {
    if (this.cache.has(key)) this.cache.delete(key);
    else if (this.cache.size >= this.limit) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
}

const articleCache = new SimpleLRUCache(200, 60 * 60 * 1000);
const errorCache = new SimpleLRUCache(100, 5 * 60 * 1000);

// ==========================================
// MIDDLEWARE & SANITIZATION HELPERS
// ==========================================

app.use((req, res, next) => {
  if (req.path === '/health' || req.path === '/') return next();
  if (!AUTH_TOKEN) return next();

  const token = req.headers['x-auth-token'] || req.query.token;
  if (token !== AUTH_TOKEN) {
    return res.status(401).send('Unauthorized');
  }
  next();
});

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeUrl(rawUrl) {
  if (!rawUrl) return null;
  let urlString = Array.isArray(rawUrl) ? String(rawUrl[rawUrl.length - 1]) : String(rawUrl);
  urlString = urlString.trim().replace(/^['"]|['"]$/g, '');

  try {
    const parsed = new URL(urlString);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href;
    }
  } catch (_) {}

  const match = urlString.match(/(https?:\/\/[^\s'"]+)/i);
  if (match) {
    try {
      const parsed = new URL(match[1]);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.href;
      }
    } catch (_) {}
  }
  return null;
}

function isJsAppShell(rawHtml) {
  if (!rawHtml) return true;
  const stripped = rawHtml
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '');

  const bodyMatch = stripped.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyContent = bodyMatch ? bodyMatch[1] : stripped;
  const textOnly = bodyContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  return textOnly.length < 150;
}

function sanitizeContent(htmlContent, targetUrl, stripAllImages = false) {
  if (!htmlContent) return '';
  let dom = null;
  try {
    dom = parseHTML(`<div>${htmlContent}</div>`);
    const doc = dom.window.document;

    const badTags = doc.querySelectorAll('script, style, iframe, object, embed, form, noscript, svg, canvas, source');
    badTags.forEach(el => el.remove());

    const styledElements = doc.querySelectorAll('[style]');
    styledElements.forEach(el => el.removeAttribute('style'));

    const imgs = doc.querySelectorAll('img');

    if (stripAllImages) {
      imgs.forEach(img => img.remove());
    } else {
      let imageCount = 0;
      const MAX_IMAGES = 5;

      imgs.forEach(img => {
        if (imageCount >= MAX_IMAGES) {
          img.remove();
          return;
        }

        const realSrc = img.getAttribute('data-src') ||
                        img.getAttribute('data-original') ||
                        img.getAttribute('data-lazy-src') ||
                        img.getAttribute('src');

        if (!realSrc || realSrc.startsWith('data:') || realSrc.includes('tracking') || realSrc.includes('pixel')) {
          img.remove();
          return;
        }

        const width = img.getAttribute('width');
        const height = img.getAttribute('height');
        if ((width === '1' || width === '0') && (height === '1' || height === '0')) {
          img.remove();
          return;
        }

        try {
          const absUrl = new URL(realSrc, targetUrl).href;
          if (!absUrl.startsWith('http://') && !absUrl.startsWith('https://')) {
            img.remove();
            return;
          }
          img.setAttribute('src', absUrl);
          imageCount++;
        } catch (_) {
          img.remove();
          return;
        }

        img.removeAttribute('data-src');
        img.removeAttribute('data-original');
        img.removeAttribute('data-lazy-src');
        img.removeAttribute('srcset');
        img.removeAttribute('loading');
        img.removeAttribute('decoding');
        img.removeAttribute('sizes');
      });

      const pictures = doc.querySelectorAll('picture');
      pictures.forEach(pic => {
        const img = pic.querySelector('img');
        if (img) pic.replaceWith(img);
        else pic.remove();
      });
    }

    return doc.body.firstElementChild ? doc.body.firstElementChild.innerHTML : htmlContent;
  } catch (e) {
    return htmlContent;
  } finally {
    if (dom && dom.window && typeof dom.window.close === 'function') {
      dom.window.close();
    }
    dom = null;
  }
}

function buildKindleHTML(title, content, targetUrl = '', stripAllImages = false) {
  const cleanedContent = targetUrl ? sanitizeContent(content, targetUrl, stripAllImages) : content;
  const safeTitle = escapeHtml(title || 'Untitled');

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=yes">
    <title>${safeTitle}</title>
    <style>
        @font-face { font-family: 'Charis SIL'; src: local('Charis SIL'); }
        html { font-size: 18px; }
        body {
            font-family: 'Charis SIL', Georgia, serif;
            line-height: 1.6;
            color: #000;
            background-color: #fff;
            margin: 0 auto;
            padding: 12px;
            font-size: 1rem;
            word-wrap: break-word;
        }
        h1 { font-size: 1.6rem; line-height: 1.3; margin-bottom: 0.4rem; }
        img { max-width: 100% !important; height: auto !important; display: block; margin: 15px auto; }
        p { margin-bottom: 1.2rem; text-align: justify; font-size: 1rem; }
        a { color: #000; text-decoration: underline; }
        blockquote { border-left: 3px solid #000; padding-left: 12px; margin-left: 0; }
        pre, code { font-family: monospace; font-size: 0.9rem; white-space: pre-wrap; }
    </style>
</head>
<body>
    <h1>${safeTitle}</h1>
    <hr>
    ${cleanedContent}
</body>
</html>`;
}

function getJinaHeaders() {
  const headers = { 'Accept': 'application/json', 'X-No-Cache': 'true' };
  if (JINA_API_KEY) headers['Authorization'] = `Bearer ${JINA_API_KEY}`;
  return headers;
}

function getCombinedSignal(timeoutMs, parentSignal) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!parentSignal) return timeoutSignal;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([timeoutSignal, parentSignal]);
  }
  return timeoutSignal;
}

function isValidContent(htmlContent) {
  if (!htmlContent) return false;

  const scanWindow = htmlContent.length > 150000 ? htmlContent.slice(0, 150000) : htmlContent;
  const plainText = scanWindow.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const lower = plainText.toLowerCase();

  const hardErrors = [
    'captcha', 'enable javascript', 'access denied',
    'security check', 'just a moment...', 'pardon our interruption',
    'enable cookies', 'cf-browser-verification'
  ];
  if (hardErrors.some(keyword => lower.includes(keyword))) {
    return false;
  }

  const wordCount = plainText.split(/\s+/).filter(Boolean).length;
  const truncationMarkers = [
    'continue reading', 'read full story', 'read full article',
    'read the full article', 'keep reading', 'subscribe to read',
    'create an account to read', 'log in to read',
    'sign in to continue', 'register to read'
  ];

  if (truncationMarkers.some(keyword => lower.includes(keyword)) && wordCount < 450) {
    return false;
  }

  const paragraphCount = (scanWindow.match(/<p[\s>]/gi) || []).length;
  return !(wordCount < 200 || paragraphCount < 2);
}

// ==========================================
// LAYER 1: BPC ENGINE & DISPATCHER
// ==========================================

function resolveBpcStrategy(targetUrl) {
  let hostname = '';
  try {
    hostname = new URL(targetUrl).hostname.replace(/^www\./, '').toLowerCase();
  } catch (_) {}

  const isBpcDomain = bpcRules.domains.includes(hostname);
  const isArchiveForced = bpcRules.archiveDomains.includes(hostname);
  const siteRule = bpcRules.sitesMap[hostname] || null;

  // 1. Build BPC Custom Headers
  const bpcHeaders = {
    'User-Agent': isBpcDomain 
      ? 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': isBpcDomain ? 'https://www.google.com/' : 'https://www.google.com/',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9'
  };

  // 2. Build Site Execution Priority Sequence
  let pipelineSequence;
  if (isArchiveForced) {
    // Forced archive routing by BPC rules
    pipelineSequence = [fetchViaArchivePh, fetchViaLiveMiddleware, fetchViaWayback, fetchDirect];
  } else {
    // Default BPC Direct-first sequence
    pipelineSequence = [fetchDirect, fetchViaLiveMiddleware, fetchViaArchivePh, fetchViaWayback];
  }

  return {
    hostname,
    isBpcDomain,
    isArchiveForced,
    siteRule,
    headers: bpcHeaders,
    pipelineSequence
  };
}

// ==========================================
// LAYER 2: FETCH TIERS
// ==========================================

// Tier A: BPC Direct Fetch + Readability (Uses Layer 1 BPC Headers)
async function fetchDirect(targetUrl, bpcConfig, parentSignal, stripImages = false) {
  let dom = null;
  try {
    const response = await fetch(targetUrl, {
      headers: bpcConfig.headers,
      signal: getCombinedSignal(2500, parentSignal)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();

    if (isJsAppShell(html)) {
      throw new Error('Raw HTML is an unrendered JS application shell');
    }

    dom = parseHTML(html);
    const doc = dom?.window?.document;
    if (!doc || !doc.documentElement) throw new Error('Invalid DOM structure');

    if (doc.head) {
      const base = doc.createElement('base');
      base.href = targetUrl;
      doc.head.appendChild(base);
    }

    const reader = new Readability(doc);
    const article = reader.parse();

    if (!article || !article.content || !isValidContent(article.content)) {
      throw new Error('Tier Content invalid or incomplete');
    }
    return buildKindleHTML(article.title, article.content, targetUrl, stripImages);
  } finally {
    if (dom && dom.window && typeof dom.window.close === 'function') {
      dom.window.close();
    }
    dom = null;
  }
}

// Tier B: Jina AI Middleware
async function fetchViaLiveMiddleware(targetUrl, bpcConfig, parentSignal, stripImages = false) {
  const response = await fetch(`https://r.jina.ai/${targetUrl}`, {
    headers: getJinaHeaders(),
    signal: getCombinedSignal(5000, parentSignal)
  });
  if (!response.ok) throw new Error(`Jina Live HTTP ${response.status}`);

  const json = await response.json();
  if (!json.data || !json.data.content) throw new Error('Jina Live payload empty');

  const htmlContent = await marked.parse(json.data.content);
  if (!isValidContent(htmlContent)) throw new Error('Jina Live content invalid or paywalled');

  return buildKindleHTML(json.data.title || 'Article', htmlContent, targetUrl, stripImages);
}

// Tier C: archive.ph via Jina AI
async function fetchViaArchivePh(targetUrl, bpcConfig, parentSignal, stripImages = false) {
  const archivePhUrl = `https://archive.ph/newest/${targetUrl}`;
  const response = await fetch(`https://r.jina.ai/${archivePhUrl}`, {
    headers: getJinaHeaders(),
    signal: getCombinedSignal(5500, parentSignal)
  });
  if (!response.ok) throw new Error(`archive.ph HTTP ${response.status}`);

  const json = await response.json();
  if (!json.data || !json.data.content) throw new Error('archive.ph payload empty');

  const htmlContent = await marked.parse(json.data.content);
  if (!isValidContent(htmlContent)) throw new Error('archive.ph snapshot not found or blocked');

  return buildKindleHTML(json.data.title || 'Archived Article', htmlContent, targetUrl, stripImages);
}

// Tier D: Wayback Machine
async function fetchViaWayback(targetUrl, bpcConfig, parentSignal, stripImages = false) {
  const apiRes = await fetch(`https://archive.org/wayback/available?url=${encodeURIComponent(targetUrl)}`, {
    signal: getCombinedSignal(4000, parentSignal)
  });
  if (!apiRes.ok) throw new Error(`Wayback API HTTP ${apiRes.status}`);

  const apiData = await apiRes.json();
  const snapshotUrl = apiData?.archived_snapshots?.closest?.url;
  if (!snapshotUrl) throw new Error('No Wayback snapshot available');

  return await fetchDirect(snapshotUrl, bpcConfig, parentSignal, stripImages);
}

// ==========================================
// PIPELINE EXECUTION
// ==========================================

async function executePipeline(targetUrl, signal, stripImages = false) {
  const cacheKey = stripImages ? `${targetUrl}#no_img` : targetUrl;
  const cachedHtml = articleCache.get(cacheKey);
  if (cachedHtml) return cachedHtml;

  if (errorCache.get(cacheKey)) {
    throw new Error('Recent extraction failure (cached error)');
  }

  // 1. EXECUTE LAYER 1: BPC Rule Evaluation
  const bpcConfig = resolveBpcStrategy(targetUrl);

  // 2. EXECUTE LAYER 2: Run BPC-driven tier pipeline
  for (const tierFn of bpcConfig.pipelineSequence) {
    try {
      if (signal?.aborted) break;
      const html = await tierFn(targetUrl, bpcConfig, signal, stripImages);
      articleCache.set(cacheKey, html);
      return html;
    } catch (_) {
      continue;
    }
  }

  errorCache.set(cacheKey, true);
  throw new Error('Failed to extract article content across all pipelines.');
}

// ==========================================
// ROUTES
// ==========================================

app.get('/health', (req, res) => res.status(200).send('OK'));

app.get('/', (req, res) => {
  res.json({
    service: 'quickrss-proxy',
    status: 'online',
    layer1_bpc_rules_loaded: bpcRules.domains.length || 0
  });
});

app.get('/extract', async (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');

  const rawUrl = req.query.url;
  if (!rawUrl) return res.status(400).send('Missing url parameter');

  const targetUrl = sanitizeUrl(rawUrl);
  if (!targetUrl) return res.status(400).send('Invalid URL provided.');

  const stripImages = req.query.no_images === 'true' || req.query.no_images === '1';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 18000);

  try {
    const result = await executePipeline(targetUrl, controller.signal, stripImages);
    return res.send(result);
  } catch (err) {
    if (controller.signal.aborted) {
      return res.status(504).send('Extraction timed out.');
    }
    return res.status(500).send('Failed to extract content across all tiers.');
  } finally {
    clearTimeout(timeout);
  }
});

app.listen(PORT, () => console.log(`QuickRSS Proxy listening on port ${PORT}`));const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Load or build BPC rules
const rulesPath = path.join(__dirname, 'bpc-rules.json');
let bpcRules = { sitesMap: {}, domains: [], archiveDomains: [] };

function loadRules() {
  if (fs.existsSync(rulesPath)) {
    bpcRules = JSON.parse(fs.readFileSync(rulesPath, 'utf-8'));
    console.log(`[SERVER] Loaded BPC Rules with ${bpcRules.totalDomains || 0} active domains.`);
  } else {
    console.warn('[SERVER] bpc-rules.json not found. Running build-bpc-rules.js...');
    require('./build-bpc-rules.js');
    if (fs.existsSync(rulesPath)) {
      bpcRules = JSON.parse(fs.readFileSync(rulesPath, 'utf-8'));
    }
  }
}

loadRules();

// Helper: Check if domain is listed
function matchDomain(targetUrl) {
  try {
    const hostname = new URL(targetUrl).hostname.replace(/^www\./, '');
    const isArchive = bpcRules.archiveDomains.includes(hostname);
    const isSupported = bpcRules.domains.includes(hostname);
    return { hostname, isSupported, isArchive };
  } catch (e) {
    return { hostname: '', isSupported: false, isArchive: false };
  }
}

// QuickRSS Proxy Endpoint
app.get('/proxy', (req, res) => {
  const targetUrl = req.query.url;

  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  const { hostname, isSupported, isArchive } = matchDomain(targetUrl);

  let fetchUrl = targetUrl;
  if (isArchive) {
    fetchUrl = `https://archive.is/newest/${encodeURIComponent(targetUrl)}`;
  }

  // Header Spoofing for Bypass
  const headers = {
    'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Referer': 'https://www.google.com/',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9'
  };

  const client = fetchUrl.startsWith('https') ? https : http;

  const proxyReq = client.get(fetchUrl, { headers }, (upstreamRes) => {
    // Pass through status and content-type
    res.status(upstreamRes.statusCode);
    res.setHeader('Content-Type', upstreamRes.headers['content-type'] || 'text/html');
    res.setHeader('X-QuickRSS-Matched-Domain', hostname);
    res.setHeader('X-QuickRSS-Bypass-Status', isSupported ? 'active' : 'passthrough');

    upstreamRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    res.status(500).json({ error: 'Proxy request failed', message: err.message });
  });
});

// API Routes
app.get('/api/domains', (req, res) => {
  res.json({
    total: bpcRules.domains.length,
    domains: bpcRules.domains
  });
});

app.get('/api/sites', (req, res) => {
  res.json(bpcRules.sitesMap);
});

app.get('/api/check', (req, res) => {
  const targetDomain = (req.query.domain || '').toLowerCase().replace(/^www\./, '');
  const isSupported = bpcRules.domains.includes(targetDomain);
  res.json({
    domain: targetDomain,
    supported: isSupported,
    requiresArchive: bpcRules.archiveDomains.includes(targetDomain)
  });
});

app.get('/', (req, res) => {
  res.json({
    name: 'quickrss-proxy',
    status: 'running',
    rulesLoaded: bpcRules.totalDomains || 0
  });
});

app.listen(PORT, () => {
  console.log(`QuickRSS Proxy listening on port ${PORT}`);
});
