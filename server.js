const express = require('express');
const { Readability } = require('@mozilla/readability');
const { parseHTML } = require('linkedom');
const { marked } = require('marked');

const app = express();
const PORT = process.env.PORT || 3000;
const JINA_API_KEY = process.env.JINA_API_KEY || '';
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';

const GOOGLEBOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

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

function isJsAppShell(rawHtml) {
    if (!rawHtml) return true;
    const lower = rawHtml.toLowerCase();

    const shellIndicators = [
        'gu-cmp-v2', 'guardian-page-skin', 'bbc-privacy-banner', 
        'consent-banner', 'sp_message_container', 'js-article-body',
        'enable javascript to view', 'please turn on javascript',
        'onetrust-consent-sdk', 'choice-consent'
    ];
    if (shellIndicators.some(indicator => lower.includes(indicator))) {
        return true;
    }

    const stripped = rawHtml
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<svg[\s\S]*?<\/svg>/gi, '');

    const bodyMatch = stripped.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const bodyContent = bodyMatch ? bodyMatch[1] : stripped;
    const textOnly = bodyContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    return textOnly.length < 250;
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
            const MAX_IMAGES = 3;

            const thumbnailPattern = /thumb|avatar|icon|logo|profile|banner|100x|150x|200x|300x|small|tile|poster/i;

            imgs.forEach(img => {
                const realSrc = img.getAttribute('data-src') || 
                                img.getAttribute('data-original') || 
                                img.getAttribute('data-lazy-src') || 
                                img.getAttribute('src') || '';

                const altText = img.getAttribute('alt') || '';

                if (
                    !realSrc || 
                    realSrc.startsWith('data:') || 
                    realSrc.includes('tracking') || 
                    realSrc.includes('pixel') ||
                    thumbnailPattern.test(realSrc) ||
                    thumbnailPattern.test(altText) ||
                    imageCount >= MAX_IMAGES
                ) {
                    img.remove();
                    return;
                }

                const width = img.getAttribute('width');
                const height = img.getAttribute('height');
                if ((width && parseInt(width) < 250) || (height && parseInt(height) < 250)) {
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
                    img.setAttribute('loading', 'lazy');
                    imageCount++;
                } catch (_) {
                    img.remove();
                    return;
                }

                img.removeAttribute('data-src');
                img.removeAttribute('data-original');
                img.removeAttribute('data-lazy-src');
                img.removeAttribute('srcset');
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
        html { font-size: 20px; }
        body {
            font-family: 'Charis SIL', Georgia, serif;
            line-height: 1.6;
            color: #000;
            background-color: #fff;
            margin: 0 auto;
            padding: 14px;
            font-size: 1.25rem; /* ~25px base font size */
            word-wrap: break-word;
        }
        h1 { font-size: 2rem; line-height: 1.25; margin-bottom: 0.6rem; font-weight: bold; }
        img { max-width: 100% !important; height: auto !important; display: block; margin: 18px auto; }
        p { margin-bottom: 1.4rem; text-align: justify; font-size: 1.25rem; }
        a { color: #000; text-decoration: underline; }
        blockquote { border-left: 4px solid #000; padding-left: 14px; margin-left: 0; font-style: italic; }
        pre, code { font-family: monospace; font-size: 1.1rem; white-space: pre-wrap; }
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
    const headers = { 
        'Accept': 'application/json', 
        'X-No-Cache': 'true',
        'X-User-Agent': GOOGLEBOT_UA
    };
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

    // Rejects cookie banners that slipped through Readability
    const consentPhrases = [
        'cookies on the bbc website',
        'notice: the guardian uses cookies',
        'welcome to bbc.com',
        'about our privacy and cookies',
        'we use cookies to give you',
        'accept all cookies',
        'agree to our use of cookies',
        'choice.consent',
        'onetrust-consent-sdk',
        'manage choices'
    ];
    if (consentPhrases.some(phrase => lower.includes(phrase))) {
        return false;
    }
    
    // Anti-bot / Captcha rejection
    const hardErrors = [
        'captcha', 'enable javascript', 'access denied', 
        'security check', 'just a moment...', 'pardon our interruption',
        'enable cookies', 'cf-browser-verification'
    ];
    if (hardErrors.some(keyword => lower.includes(keyword))) {
        return false;
    }

    // Truncation & Paywall Teaser Detection (< 450 words with trigger phrases)
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

    // Minimum Content Threshold (At least 250 words and 2 paragraphs)
    const paragraphCount = (scanWindow.match(/<p[\s>]/gi) || []).length;
    return !(wordCount < 250 || paragraphCount < 2);
}

// Fallback 1: Extract full article text directly from JSON-LD schema (BBC, Guardian, NYT)
function extractFromJSONLD(doc) {
    try {
        const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
        for (const script of scripts) {
            if (!script.textContent) continue;
            let data = null;
            try {
                data = JSON.parse(script.textContent);
            } catch (_) { continue; }

            const items = Array.isArray(data) ? data : [data];
            for (const item of items) {
                const graph = item['@graph'] || [item];
                for (const node of graph) {
                    if (node && node.articleBody && typeof node.articleBody === 'string' && node.articleBody.length > 400) {
                        const title = node.headline || node.name || '';
                        const paragraphs = node.articleBody
                            .split(/\n+/)
                            .map(p => p.trim())
                            .filter(p => p.length > 20)
                            .map(p => `<p>${escapeHtml(p)}</p>`)
                            .join('');
                        return { title, content: paragraphs };
                    }
                }
            }
        }
    } catch (_) {}
    return null;
}

// Fallback 2: Extract paragraphs directly targeting BBC, Guardian, and React CSS designs
function extractFromDOMParagraphs(doc) {
    try {
        const selectors = [
            'main p', 'article p', 
            '[data-component="text-block"]', 
            '[class*="article-body"] p', 
            '[class*="Paragraph"] p', 
            '#maincontent p'
        ];
        const nodes = doc.querySelectorAll(selectors.join(', '));
        const paragraphs = [];

        nodes.forEach(node => {
            const text = node.textContent ? node.textContent.trim() : '';
            const lower = text.toLowerCase();
            if (
                text.length > 30 && 
                !lower.includes('cookie') && 
                !lower.includes('privacy policy') &&
                !lower.includes('terms of use')
            ) {
                paragraphs.push(`<p>${escapeHtml(text)}</p>`);
            }
        });

        if (paragraphs.length >= 3) {
            const titleNode = doc.querySelector('h1');
            const title = titleNode ? titleNode.textContent.trim() : '';
            return { title, content: paragraphs.join('') };
        }
    } catch (_) {}
    return null;
}

// Tier 1: Direct Fetch with Googlebot User-Agent + Schema & Fallback Extractors
async function fetchDirect(targetUrl, parentSignal, stripImages = false) {
    let dom = null;
    try {
        const response = await fetch(targetUrl, {
            headers: {
                'User-Agent': GOOGLEBOT_UA,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5'
            },
            signal: getCombinedSignal(2500, parentSignal)
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const html = await response.text();

        if (isJsAppShell(html)) {
            throw new Error('Raw HTML is a JS application shell or consent banner');
        }

        dom = parseHTML(html);
        const doc = dom?.window?.document;
        if (!doc || !doc.documentElement) throw new Error('Invalid DOM structure');

        if (doc.head) {
            const base = doc.createElement('base');
            base.href = targetUrl;
            doc.head.appendChild(base);
        }

        // Strategy A: Standard Readability
        let extractedTitle = '';
        let extractedContent = '';

        const reader = new Readability(doc);
        const article = reader.parse();

        if (article && article.content && isValidContent(article.content)) {
            extractedTitle = article.title;
            extractedContent = article.content;
        } else {
            // Strategy B: Structured JSON-LD Metadata (BBC/Guardian)
            const jsonLdResult = extractFromJSONLD(doc);
            if (jsonLdResult && isValidContent(jsonLdResult.content)) {
                extractedTitle = jsonLdResult.title;
                extractedContent = jsonLdResult.content;
            } else {
                // Strategy C: Target-Specific DOM Paragraph Queries
                const domResult = extractFromDOMParagraphs(doc);
                if (domResult && isValidContent(domResult.content)) {
                    extractedTitle = domResult.title;
                    extractedContent = domResult.content;
                }
            }
        }

        if (!extractedContent || !isValidContent(extractedContent)) {
            throw new Error('Tier 1 content invalid or incomplete across all strategies');
        }

        return buildKindleHTML(extractedTitle, extractedContent, targetUrl, stripImages);
    } finally {
        if (dom && dom.window && typeof dom.window.close === 'function') {
            dom.window.close();
        }
        dom = null;
    }
}

// Tier 2: Jina AI Middleware (5.0s)
async function fetchViaLiveMiddleware(targetUrl, parentSignal, stripImages = false) {
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

// Tier 3: archive.ph (5.5s)
async function fetchViaArchivePh(targetUrl, parentSignal, stripImages = false) {
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

// Tier 4: Wayback Machine (4.0s)
async function fetchViaWayback(targetUrl, parentSignal, stripImages = false) {
    const apiRes = await fetch(`https://archive.org/wayback/available?url=${encodeURIComponent(targetUrl)}`, {
        signal: getCombinedSignal(4000, parentSignal)
    });
    if (!apiRes.ok) throw new Error(`Wayback API HTTP ${apiRes.status}`);

    const apiData = await apiRes.json();
    const snapshotUrl = apiData?.archived_snapshots?.closest?.url;
    if (!snapshotUrl) throw new Error('No Wayback snapshot available');

    return await fetchDirect(snapshotUrl, parentSignal, stripImages);
}

// Pipeline Execution
async function executePipeline(targetUrl, signal, stripImages = false) {
    const cacheKey = stripImages ? `${targetUrl}#no_img` : targetUrl;
    const cachedHtml = articleCache.get(cacheKey);
    if (cachedHtml) return cachedHtml;

    if (errorCache.get(cacheKey)) {
        throw new Error('Recent extraction failure (cached error)');
    }

    const pipeline = [fetchDirect, fetchViaLiveMiddleware, fetchViaArchivePh, fetchViaWayback];

    for (const tierFn of pipeline) {
        try {
            if (signal?.aborted) break;
            const html = await tierFn(targetUrl, signal, stripImages);
            articleCache.set(cacheKey, html);
            return html;
        } catch (_) {
            continue;
        }
    }

    errorCache.set(cacheKey, true);
    throw new Error('Failed to extract article content across all pipelines.');
}

app.get('/health', (req, res) => res.status(200).send('OK'));

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

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
