// server.js
const express = require('express');
const { Readability } = require('@mozilla/readability');
const { parseHTML } = require('linkedom');
const { marked } = require('marked');
const JSZip = require('jszip');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JINA_API_KEY = process.env.JINA_API_KEY || '';
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';

const HARDCODED_ARCHIVE_DOMAINS = new Set([
  'economist.com',
  'ft.com',
  'bloomberg.com',
  'barrons.com',
  'wsj.com',
  'nytimes.com',
  'washingtonpost.com',
  'theatlantic.com',
  'spiegel.de',
  'zeit.de',
  'welt.de'
]);

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

HARDCODED_ARCHIVE_DOMAINS.forEach(d => bpcRules.archiveDomains.add(d));

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

function sanitizeContent(htmlContent, targetUrl, stripAllImages = false) {
  if (!htmlContent) return '';
  let dom = null;
  try {
    dom = parseHTML(`<div>${htmlContent}</div>`);
    const doc = dom.window.document;

    const badTags = doc.querySelectorAll('script, style, iframe, object, embed, form, noscript, svg, canvas, source');
    badTags.forEach(el => el.remove());

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

function buildQuickRSSHTML(title, content, targetUrl = '', stripAllImages = false) {
  const cleanedContent = targetUrl ? sanitizeContent(content, targetUrl, stripAllImages) : content;
  const safeTitle = escapeHtml(title || 'Untitled');

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>${safeTitle}</title>
    <style>
        body { line-height: 1.6; word-wrap: break-word; }
        h1 { line-height: 1.3; margin-bottom: 0.4em; }
        p { margin-bottom: 1.2em; text-align: justify; }
        img { max-width: 100%; height: auto; display: block; margin: 1em auto; }
        a { color: inherit; text-decoration: underline; }
        blockquote { border-left: 3px solid #000; padding-left: 12px; margin-left: 0; }
        pre, code { font-family: monospace; white-space: pre-wrap; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #ccc; padding: 6px; }
    </style>
</head>
<body>
    <h1>${safeTitle}</h1>
    <hr>
    ${cleanedContent}
</body>
</html>`;
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

async function buildEpub(title, content, targetUrl = '', stripAllImages = false) {
  const cleanedContent = targetUrl ? sanitizeContent(content, targetUrl, stripAllImages) : content;
  const safeTitle = escapeHtml(title || 'Untitled');
  const id = 'id-' + Math.random().toString(36).slice(2);

  const css = `body { font-family: 'Charis SIL', Georgia, serif; line-height: 1.6; }
img { max-width: 100%; height: auto; display: block; margin: 15px auto; }
a { color: #000; text-decoration: underline; }
blockquote { border-left: 3px solid #000; padding-left: 12px; margin-left: 0; }
pre, code { font-family: monospace; white-space: pre-wrap; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #ccc; padding: 6px; }`;

  const chapterXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
    <title>${safeTitle}</title>
    <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
    <h1>${safeTitle}</h1>
    <hr/>
    ${cleanedContent}
</body>
</html>`;

  const containerXml = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
    <rootfiles>
        <rootfile full-path="content.opf" media-type="application/oebps-package+xml"/>
    </rootfiles>
</container>`;

  const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
<package version="2.0" xmlns="http://www.idpf.org/2007/opf">
    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:title>${safeTitle}</dc:title>
        <dc:identifier id="bookid">${id}</dc:identifier>
        <dc:language>en</dc:language>
    </metadata>
    <manifest>
        <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
        <item id="style" href="style.css" media-type="text/css"/>
        <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
    </manifest>
    <spine toc="ncx">
        <itemref idref="chapter"/>
    </spine>
</package>`;

  const tocNcx = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx version="2005-1" xmlns="http://www.daisy.org/z3986/2005/ncx/">
    <head>
        <meta name="dtb:uid" content="${id}"/>
        <meta name="dtb:depth" content="1"/>
    </head>
    <docTitle><text>${safeTitle}</text></docTitle>
    <navMap>
        <navPoint id="navpoint-1" playOrder="1">
            <navLabel><text>${safeTitle}</text></navLabel>
            <content src="chapter.xhtml"/>
        </navPoint>
    </navMap>
</ncx>`;

  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.folder('META-INF').file('container.xml', containerXml);
  zip.file('content.opf', contentOpf);
  zip.file('toc.ncx', tocNcx);
  zip.file('style.css', css);
  zip.file('chapter.xhtml', chapterXhtml);

  return await zip.generateAsync({ type: 'nodebuffer' });
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

function resolveBpcStrategy(targetUrl) {
  let hostname = '';
  try {
    hostname = new URL(targetUrl).hostname.replace(/^www\./, '').toLowerCase();
  } catch (_) {}

  const isBpcDomain = matchesDomainSet(hostname, bpcRules.domains);
  const isArchiveForced = matchesDomainSet(hostname, bpcRules.archiveDomains);
  const siteRule = findSiteRule(hostname, bpcRules.sitesMap);
  const forceStripImages = siteRule?.stripImages === true;

  // Standard domains use Jina AI as Tier 1.
  // Archive-forced domains bypass Jina AI and route straight to web archive mirrors.
  const pipelineSequence = isArchiveForced
    ? [fetchViaArchivePh, fetchViaArchiveToday, fetchViaGhostArchive, fetchViaWayback]
    : [fetchViaLiveMiddleware, fetchViaArchivePh, fetchViaWayback];

  return {
    hostname,
    isBpcDomain,
    isArchiveForced,
    siteRule,
    forceStripImages,
    pipelineSequence
  };
}

async function fetchViaLiveMiddleware(targetUrl, bpcConfig, parentSignal, stripImages = false) {
  const headers = getJinaHeaders();
  if (bpcConfig.siteRule?.useragent) {
    headers['X-User-Agent'] = bpcConfig.siteRule.useragent;
  }

  const response = await fetch(`https://r.jina.ai/${targetUrl}`, {
    headers,
    signal: getCombinedSignal(12000, parentSignal)
  });
  if (!response.ok) throw new Error(`Jina Live HTTP ${response.status}`);

  const json = await response.json();
  if (!json.data || !json.data.content) throw new Error('Jina Live payload empty');

  const htmlContent = await marked.parse(json.data.content);
  if (!isValidContent(htmlContent)) throw new Error('Jina Live content invalid or paywalled');

  return { title: json.data.title || 'Article', content: htmlContent, url: targetUrl };
}

async function fetchViaArchivePh(targetUrl, bpcConfig, parentSignal, stripImages = false) {
  await new Promise(r => setTimeout(r, 500));

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

  return { title: json.data.title || 'Archived Article', content: htmlContent, url: targetUrl };
}

async function fetchViaArchiveToday(targetUrl, bpcConfig, parentSignal, stripImages = false) {
  await new Promise(r => setTimeout(r, 500));

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

  return { title: json.data.title || 'Archived Article', content: htmlContent, url: targetUrl };
}

async function fetchViaGhostArchive(targetUrl, bpcConfig, parentSignal, stripImages = false) {
  const ghostUrl = `https://ghostarchive.org/archive/${encodeURIComponent(targetUrl)}`;
  const response = await fetch(`https://r.jina.ai/${ghostUrl}`, {
    headers: getJinaHeaders(),
    signal: getCombinedSignal(12000, parentSignal)
  });
  if (!response.ok) throw new Error(`Ghost Archive HTTP ${response.status}`);

  const json = await response.json();
  if (!json.data || !json.data.content) throw new Error('Ghost Archive payload empty');

  const htmlContent = await marked.parse(json.data.content);
  if (!isValidContent(htmlContent)) throw new Error('Ghost Archive snapshot missing or blocked');

  return { title: json.data.title || 'Archived Article', content: htmlContent, url: targetUrl };
}

async function fetchViaWayback(targetUrl, bpcConfig, parentSignal, stripImages = false) {
  const apiRes = await fetch(`https://archive.org/wayback/available?url=${encodeURIComponent(targetUrl)}`, {
    signal: getCombinedSignal(6000, parentSignal)
  });
  if (!apiRes.ok) throw new Error(`Wayback API HTTP ${apiRes.status}`);

  const apiData = await apiRes.json();
  const snapshotUrl = apiData?.archived_snapshots?.closest?.url;
  if (!snapshotUrl) throw new Error('No Wayback snapshot available');

  const response = await fetch(`https://r.jina.ai/${snapshotUrl}`, {
    headers: getJinaHeaders(),
    signal: getCombinedSignal(12000, parentSignal)
  });
  if (!response.ok) throw new Error(`Wayback Jina Fetch HTTP ${response.status}`);

  const json = await response.json();
  if (!json.data || !json.data.content) throw new Error('Wayback payload empty');

  const htmlContent = await marked.parse(json.data.content);
  if (!isValidContent(htmlContent)) throw new Error('Wayback snapshot invalid');

  return { title: json.data.title || 'Archived Article', content: htmlContent, url: targetUrl };
}

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
      const article = await tierFn(targetUrl, bpcConfig, signal, effectiveStripImages);
      articleCache.set(cacheKey, article);
      return article;
    } catch (err) {
      if (debug) {
        console.error(`[DEBUG] [${bpcConfig.hostname}] [${tierFn.name}] Failed: ${err.message}`);
      }
      continue;
    }
  }

  if (!signal?.aborted) {
    errorCache.set(cacheKey, true);
  }

  throw new Error('Failed to extract article content across all pipelines.');
}

app.get('/health', (req, res) => res.status(200).send('OK'));

app.get('/', (req, res) => {
  res.json({
    service: 'quickrss-proxy',
    status: 'online',
    tier1_provider: 'Jina AI',
    bpc_rules_loaded: bpcRules.domains.size || 0,
    hardcoded_archive_domains: HARDCODED_ARCHIVE_DOMAINS.size
  });
});

app.get('/extract', async (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl) return res.status(400).send('Missing url parameter');

  const targetUrl = sanitizeUrl(rawUrl);
  if (!targetUrl) return res.status(400).send('Invalid URL provided.');

  const stripImages = req.query.no_images === 'true' || req.query.no_images === '1';
  const debug = req.query.debug === 'true' || req.query.debug === '1';
  const format = req.query.format || 'html';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35000);

  try {
    const article = await executePipeline(targetUrl, controller.signal, stripImages, debug);

    if (format === 'epub') {
      const epubBuffer = await buildEpub(article.title, article.content, targetUrl, stripImages);
      res.set('Content-Type', 'application/epub+zip');
      res.set('Content-Disposition', `attachment; filename="${(article.title || 'article').replace(/[^a-z0-9]/gi, '_').slice(0, 60)}.epub"`);
      return res.send(epubBuffer);
    }

    if (format === 'quickrss') {
      const html = buildQuickRSSHTML(article.title, article.content, targetUrl, stripImages);
      res.set('Content-Type', 'text/html; charset=utf-8');
      return res.send(html);
    }

    const html = buildKindleHTML(article.title, article.content, targetUrl, stripImages);
    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);

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
