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

// Load BPC rules compiled from bpc-extension
const rulesPath = path.join(__dirname, 'bpc-rules.json');
let bpcRules = { sitesMap: {}, domains: new Set(), archiveDomains: new Set() };

if (fs.existsSync(rulesPath)) {
  try {
    const raw = JSON.parse(fs.readFileSync(rulesPath, 'utf-8'));
    bpcRules = {
      sitesMap: raw.sitesMap || {},
      domains: new Set((raw.domains || []).map(d => d.toLowerCase())),
      archiveDomains: new Set((raw.archiveDomains || []).map(d => d.toLowerCase()))
    };
    console.log(`[BPC RULE ENGINE] Loaded ${bpcRules.domains.size} domains (${bpcRules.archiveDomains.size} archive-flagged).`);
  } catch (err) {
    console.warn('[BPC RULE ENGINE] Warning: Failed to parse bpc-rules.json');
  }
}

// Subdomain-depth lookup against Set
function matchesDomainSet(hostname, domainSet) {
  if (!hostname || !(domainSet instanceof Set)) return false;
  if (domainSet.has(hostname)) return true;

  const parts = hostname.split('.');
  for (let i = 1; i < parts.length; i++) {
    const parentDomain = parts.slice(i).join('.');
    if (domainSet.has(parentDomain)) return true;
  }
  return false;
}

// Subdomain-depth lookup for site configuration rules (Non-mutating)
function findSiteRule(hostname, sitesMap = {}) {
  if (!hostname || !sitesMap) return null;
  if (sitesMap[hostname]) return sitesMap[hostname];

  const parts = hostname.split('.');
  for (let i = 1; i < parts.length; i++) {
    const parentDomain = parts.slice(i).join('.');
    if (sitesMap[parentDomain]) return sitesMap[parentDomain];
  }
  return null;
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

    // Security Hardening: Strip inline styling and on* event attributes
    const allElements = doc.querySelectorAll('*');
    allElements.forEach(el => {
      el.removeAttribute('style');
      if (el.attributes) {
        Array.from(el.attributes).forEach(attr => {
          if (attr.name.startsWith('on')) {
            el.removeAttribute(attr.name);
          }
        });
      }
    });

    const imgs = doc.querySelectorAll('img');

    if (stripAllImages) {
      imgs.forEach(img => img.remove());
    } else {
      let imageCount = 0;
      const MAX_IMAGES = 5;

      imgs.forEach(img => {
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

        if (imageCount >= MAX_IMAGES) {
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
  const headers = { 'Accept': 'application/json' };
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
// BPC RULE STRATEGY RESOLVER
// ==========================================

function resolveBpcStrategy(targetUrl) {
  let hostname = '';
  try {
    hostname = new URL(targetUrl).hostname.replace(/^www\./, '').toLowerCase();
  } catch (_) {}

  const isBpcDomain = matchesDomainSet(hostname, bpcRules.domains);
  const isArchiveForced = matchesDomainSet(hostname, bpcRules.archiveDomains);
  const siteRule = findSiteRule(hostname, bpcRules.sitesMap);
  const forceStripImages = siteRule?.stripImages === true;

  // Default universally to Googlebot UA & Google Referer for pre-rendered SEO markup on free news sites
  let userAgent = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
  let referer = 'https://www.google.com/';

  // Override if siteRule explicitly demands custom headers
  if (siteRule?.useragent) {
    userAgent = siteRule.useragent;
  }
  if (siteRule?.referer) {
    referer = siteRule.referer;
  }

  const bpcHeaders = {
    'User-Agent': userAgent,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9'
  };
  if (referer) bpcHeaders['Referer'] = referer;

  if (siteRule?.customHeaders) {
    Object.assign(bpcHeaders, siteRule.customHeaders);
  }

  const pipelineSequence = isArchiveForced
    ? [fetchViaArchivePh, fetchViaArchiveToday, fetchViaLiveMiddleware, fetchViaWayback, fetchDirect]
    : [fetchDirect, fetchViaLiveMiddleware, fetchViaArchivePh, fetchViaArchiveToday, fetchViaWayback];

  return {
    hostname,
    isBpcDomain,
    isArchiveForced,
    siteRule,
    forceStripImages,
    headers: bpcHeaders,
    pipelineSequence
  };
}

// ==========================================
// FETCH TIERS
// ==========================================

async function fetchDirect(targetUrl, bpcConfig, parentSignal, stripImages = false) {
  let dom = null;
  try {
    const requestedTimeout = bpcConfig.siteRule?.timeoutMs || 2500;
    const timeoutMs = Math.min(requestedTimeout, 4000);

    const response = await fetch(targetUrl, {
      headers: bpcConfig.headers,
      signal: getCombinedSignal(timeoutMs, parentSignal)
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
      throw new Error('Tier 1 content invalid or incomplete');
    }
    return buildKindleHTML(article.title, article.content, targetUrl, stripImages);
  } finally {
    if (dom && dom.window && typeof dom.window.close === 'function') {
      dom.window.close();
    }
    dom = null;
  }
}

async function fetchViaLiveMiddleware(targetUrl, bpcConfig, parentSignal, stripImages = false) {
  const response = await fetch(`https://r.jina.ai/${targetUrl}`, {
    headers: getJinaHeaders(),
    signal: getCombinedSignal(10000, parentSignal)
  });
  if (!response.ok) throw new Error(`Jina Live HTTP ${response.status}`);

  const json = await response.json();
  if (!json.data || !json.data.content) throw new Error('Jina Live payload empty');

  const htmlContent = await marked.parse(json.data.content);
  if (!isValidContent(htmlContent)) throw new Error('Jina Live content invalid or paywalled');

  return buildKindleHTML(json.data.title || 'Article', htmlContent, targetUrl, stripImages);
}

async function fetchViaArchivePh(targetUrl, bpcConfig, parentSignal, stripImages = false) {
  // Properly URL-encoded to prevent query parameter leaks to archive.ph
  const archivePhUrl = `https://archive.ph/newest/${encodeURIComponent(targetUrl)}`;
  const response = await fetch(`https://r.jina.ai/${archivePhUrl}`, {
    headers: getJinaHeaders(),
    signal: getCombinedSignal(15000, parentSignal)
  });
  if (!response.ok) throw new Error(`archive.ph HTTP ${response.status}`);

  const json = await response.json();
  if (!json.data || !json.data.content) throw new Error('archive.ph payload empty');

  const htmlContent = await marked.parse(json.data.content);
  if (!isValidContent(htmlContent)) throw new Error('archive.ph snapshot not found or blocked');

  return buildKindleHTML(json.data.title || 'Archived Article', htmlContent, targetUrl, stripImages);
}

async function fetchViaArchiveToday(targetUrl, bpcConfig, parentSignal, stripImages = false) {
  const archiveTodayUrl = `https://archive.today/newest/${encodeURIComponent(targetUrl)}`;
  const response = await fetch(`https://r.jina.ai/${archiveTodayUrl}`, {
    headers: getJinaHeaders(),
    signal: getCombinedSignal(15000, parentSignal)
  });
  if (!response.ok) throw new Error(`archive.today HTTP ${response.status}`);

  const json = await response.json();
  if (!json.data || !json.data.content) throw new Error('archive.today payload empty');

  const htmlContent = await marked.parse(json.data.content);
  if (!isValidContent(htmlContent)) throw new Error('archive.today snapshot missing or blocked');

  return buildKindleHTML(json.data.title || 'Archived Article', htmlContent, targetUrl, stripImages);
}

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

async function executePipeline(targetUrl, signal, stripImages = false, debug = false) {
  const bpcConfig = resolveBpcStrategy(targetUrl);
  const effectiveStripImages = stripImages || bpcConfig.forceStripImages;

  const cacheKey = effectiveStripImages ? `${targetUrl}#no_img` : targetUrl;
  const cachedHtml = articleCache.get(cacheKey);
  if (cachedHtml) return cachedHtml;

  if (errorCache.get(cacheKey)) {
    throw new Error('Recent extraction failure (cached error)');
  }

  for (const tierFn of bpcConfig.pipelineSequence) {
    try {
      if (signal?.aborted) break;
      const html = await tierFn(targetUrl, bpcConfig, signal, effectiveStripImages);
      articleCache.set(cacheKey, html);
      return html;
    } catch (err) {
      if (debug) {
        console.error(`[DEBUG] [${bpcConfig.hostname}] [${tierFn.name}] Failed: ${err.message}`);
      }
      continue;
    }
  }

  // Only write to errorCache if the failure was not due to an abort signal
  if (!signal?.aborted) {
    errorCache.set(cacheKey, true);
  }

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
    bpc_rules_loaded: bpcRules.domains.size || 0
  });
});

app.get('/extract', async (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');

  const rawUrl = req.query.url;
  if (!rawUrl) return res.status(400).send('Missing url parameter');

  const targetUrl = sanitizeUrl(rawUrl);
  if (!targetUrl) return res.status(400).send('Invalid URL provided.');

  const stripImages = req.query.no_images === 'true' || req.query.no_images === '1';
  const debug = req.query.debug === 'true' || req.query.debug === '1';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

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

app.listen(PORT, () => console.log(`QuickRSS Proxy listening on port ${PORT}`));
