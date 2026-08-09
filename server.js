const express = require('express');
const { Readability } = require('@mozilla/readability');
const { parseHTML } = require('linkedom');
const { marked } = require('marked');

const app = express();
const PORT = process.env.PORT || 3000;
const JINA_API_KEY = process.env.JINA_API_KEY || '';
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';

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
    if (req.path === '/health') return next();
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

// Detects raw HTML that is just a Client-Side Rendering (SPA) app shell or noscript block
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

// Cleans inline styles (prevents scaling issues) and updates image links
function sanitizeContent(htmlContent, targetUrl) {
    if (!htmlContent) return '';
    let dom = null;
    try {
        dom = parseHTML(`<div>${htmlContent}</div>`);
        const doc = dom.window.document;

        // Remove inline styles that break E-ink layout/fonts
        const styledElements = doc.querySelectorAll('[style]');
        styledElements.forEach(el => el.removeAttribute('style'));

        // Fix image paths
        const imgs = doc.querySelectorAll('img');
        imgs.forEach(img => {
            const realSrc = img.getAttribute('data-src') || 
                            img.getAttribute('data-original') || 
                            img.getAttribute('data-lazy-src') || 
                            img.getAttribute('src');

            if (!realSrc || realSrc.startsWith('data:')) {
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
                img.setAttribute('src', absUrl);
            } catch (_) {
                img.remove();
                return;
            }

            img.removeAttribute('data-src');
            img.removeAttribute('data-original');
            img.removeAttribute('data-lazy-src');
            img.removeAttribute('srcset');
        });

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

function buildKindleHTML(title, content, targetUrl = '') {
    const cleanedContent = targetUrl ? sanitizeContent(content, targetUrl) : content;
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

// Universal Content Quality Gate
function isValidContent(htmlContent) {
    if (!htmlContent) return false;

    const scanWindow = htmlContent.length > 150000 ? htmlContent.slice(0, 150000) : htmlContent;
    const plainText = scanWindow.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const lower = plainText.toLowerCase();
    
    // 1. Anti-bot / Captcha rejection
    const hardErrors = [
        'captcha', 'enable javascript', 'access denied', 
        'security check', 'just a moment...', 'pardon our interruption',
        'enable cookies', 'cf-browser-verification'
    ];
    if (hardErrors.some(keyword => lower.includes(keyword))) {
        return false;
    }

    // 2. Truncation & Paywall Teaser Detection (< 800 words with trigger phrases)
    const wordCount = plainText.split(/\s+/).filter(Boolean).length;
    const truncationMarkers = [
        'continue reading', 'read full story', 'read full article', 
        'read the full article', 'keep reading', 'subscribe to read', 
        'create an account to read', 'log in to read', 
        'sign in to continue', 'register to read'
    ];

    if (truncationMarkers.some(keyword => lower.includes(keyword)) && wordCount < 800) {
        return false;
    }

    // 3. Absolute Minimum Word Threshold (300 words)
    const paragraphCount = (scanWindow.match(/<p[\s>]/gi) || []).length;
    return !(wordCount < 300 || paragraphCount < 2);
}

// Tier 1: Direct Fetch
async function fetchDirect(targetUrl, parentSignal) {
    let dom = null;
    try {
        const response = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5'
            },
            signal: getCombinedSignal(2500, parentSignal)
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const html = await response.text();

        // Immediately throw if the raw payload is an unrendered JS app shell
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
        return buildKindleHTML(article.title, article.content, targetUrl);
    } finally {
        if (dom && dom.window && typeof dom.window.close === 'function') {
            dom.window.close();
        }
        dom = null;
    }
}

// Tier 2: Jina AI Middleware
async function fetchViaLiveMiddleware(targetUrl, parentSignal) {
    const response = await fetch(`https://r.jina.ai/${targetUrl}`, {
        headers: getJinaHeaders(),
        signal: getCombinedSignal(6500, parentSignal)
    });
    if (!response.ok) throw new Error(`Jina Live HTTP ${response.status}`);
    
    const json = await response.json();
    if (!json.data || !json.data.content) throw new Error('Jina Live payload empty');

    const htmlContent = await marked.parse(json.data.content);
    if (!isValidContent(htmlContent)) throw new Error('Jina Live content invalid or paywalled');

    return buildKindleHTML(json.data.title || 'Article', htmlContent, targetUrl);
}

// Tier 3: archive.ph
async function fetchViaArchivePh(targetUrl, parentSignal) {
    const archivePhUrl = `https://archive.ph/newest/${targetUrl}`;
    const response = await fetch(`https://r.jina.ai/${archivePhUrl}`, {
        headers: getJinaHeaders(),
        signal: getCombinedSignal(7000, parentSignal)
    });
    if (!response.ok) throw new Error(`archive.ph HTTP ${response.status}`);

    const json = await response.json();
    if (!json.data || !json.data.content) throw new Error('archive.ph payload empty');

    const htmlContent = await marked.parse(json.data.content);
    if (!isValidContent(htmlContent)) throw new Error('archive.ph snapshot not found or blocked');

    return buildKindleHTML(json.data.title || 'Archived Article', htmlContent, targetUrl);
}

// Tier 4: Wayback Machine
async function fetchViaWayback(targetUrl, parentSignal) {
    const apiRes = await fetch(`https://archive.org/wayback/available?url=${encodeURIComponent(targetUrl)}`, {
        signal: getCombinedSignal(4000, parentSignal)
    });
    if (!apiRes.ok) throw new Error(`Wayback API HTTP ${apiRes.status}`);

    const apiData = await apiRes.json();
    const snapshotUrl = apiData?.archived_snapshots?.closest?.url;
    if (!snapshotUrl) throw new Error('No Wayback snapshot available');

    return await fetchDirect(snapshotUrl, parentSignal);
}

// Pipeline Execution (Universal Order)
async function executePipeline(targetUrl, signal) {
    const cachedHtml = articleCache.get(targetUrl);
    if (cachedHtml) return cachedHtml;

    if (errorCache.get(targetUrl)) {
        throw new Error('Recent extraction failure (cached error)');
    }

    const pipeline = [fetchDirect, fetchViaLiveMiddleware, fetchViaArchivePh, fetchViaWayback];

    for (const tierFn of pipeline) {
        try {
            if (signal?.aborted) break;
            const html = await tierFn(targetUrl, signal);
            articleCache.set(targetUrl, html);
            return html;
        } catch (_) {
            continue;
        }
    }

    errorCache.set(targetUrl, true);
    throw new Error('Failed to extract article content across all pipelines.');
}

app.get('/health', (req, res) => res.status(200).send('OK'));

app.get('/extract', async (req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8');

    const rawUrl = req.query.url;
    if (!rawUrl) return res.status(400).send('Missing url parameter');

    const targetUrl = sanitizeUrl(rawUrl);
    if (!targetUrl) return res.status(400).send('Invalid URL provided.');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 16000);

    try {
        const result = await executePipeline(targetUrl, controller.signal);
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

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
