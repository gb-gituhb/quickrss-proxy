const express = require('express');
const { Readability } = require('@mozilla/readability');
const { parseHTML } = require('linkedom');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// User-Agent Registry
const UA_GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const UA_BINGBOT = 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)';
const UA_TWITTER = 'Twitterbot/1.0';
const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// 1. Load Compiled BPC Rules
let BPC_RULES = {};
try {
    const rulesPath = path.join(__dirname, 'bpc_sites.json');
    if (fs.existsSync(rulesPath)) {
        BPC_RULES = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
        console.log(`Loaded ${Object.keys(BPC_RULES).length} rules from bpc_sites.json`);
    } else {
        console.warn('bpc_sites.json not found. Run "node build-bpc-rules.js" first.');
    }
} catch (err) {
    console.error('Error reading bpc_sites.json:', err.message);
}

// Known Paywall Engine Keyword Fallbacks
const PAYWALL_PLATFORMS = ['piano.io', 'tinypass.com', 'poool.fr', 'bloxcms.com', 'gannett.com'];

function getBpcRule(targetUrl) {
    try {
        const hostname = new URL(targetUrl).hostname.toLowerCase().replace(/^www\./, '');
        
        for (const [domain, rule] of Object.entries(BPC_RULES)) {
            if (hostname === domain || hostname.endsWith('.' + domain)) {
                return rule;
            }
        }

        if (PAYWALL_PLATFORMS.some(platform => hostname.includes(platform))) {
            return { strategy: 'strip_cookies' };
        }
    } catch (_) {}
    return { strategy: 'default' };
}

// 2. Memory LRU Cache (<15 MB RAM Target)
class SimpleLRUCache {
    constructor(limit = 250, ttlMs = 60 * 60 * 1000) {
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
const articleCache = new SimpleLRUCache(250, 60 * 60 * 1000);

// Helper Functions
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
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
    } catch (_) {}
    return null;
}

function isValidContent(text) {
    if (!text) return false;
    const clean = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const wordCount = clean.split(/\s+/).filter(Boolean).length;
    const lower = clean.toLowerCase();

    if (lower.includes('cookies on the bbc') || lower.includes('accept cookies') || lower.includes('enable javascript')) {
        return false;
    }
    return wordCount >= 180;
}

function sanitizeContent(htmlContent, targetUrl, stripAllImages = false) {
    if (!htmlContent) return '';
    let dom = null;
    try {
        dom = parseHTML(`<div>${htmlContent}</div>`);
        const doc = dom.window.document;

        const badSelectors = [
            'script', 'style', 'iframe', 'object', 'embed', 'form', 'noscript', 'svg', 'canvas',
            'div[class*="paywall"]', 'div[class*="subscription"]', 'div[id*="paywall"]',
            'div[class*="cookie"]', 'div[class*="consent"]', 'div[id*="onetrust"]', 'tp-modal'
        ];
        doc.querySelectorAll(badSelectors.join(', ')).forEach(el => el.remove());

        doc.querySelectorAll('[style]').forEach(el => el.removeAttribute('style'));

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

                if (!realSrc || realSrc.startsWith('data:') || thumbnailPattern.test(realSrc) || imageCount >= MAX_IMAGES) {
                    img.remove();
                    return;
                }

                try {
                    const absUrl = new URL(realSrc, targetUrl).href;
                    if (!absUrl.startsWith('http://') || !absUrl.startsWith('https://')) {
                        img.removeAttribute('srcset');
                        img.setAttribute('src', absUrl);
                        img.setAttribute('loading', 'lazy');
                        imageCount++;
                    }
                } catch (_) {
                    img.remove();
                }
            });
        }

        return doc.body.firstElementChild ? doc.body.firstElementChild.innerHTML : htmlContent;
    } catch (e) {
        return htmlContent;
    } finally {
        if (dom && dom.window && typeof dom.window.close === 'function') dom.window.close();
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
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${safeTitle}</title>
    <style>
        body { font-family: Georgia, serif; line-height: 1.6; color: #000; background-color: #fff; padding: 14px; font-size: 1.25rem; word-wrap: break-word; }
        h1 { font-size: 2rem; line-height: 1.25; margin-bottom: 0.6rem; }
        img { max-width: 100% !important; height: auto !important; display: block; margin: 18px auto; }
        p { margin-bottom: 1.4rem; text-align: justify; }
    </style>
</head>
<body>
    <h1>${safeTitle}</h1>
    <hr>
    ${cleanedContent}
</body>
</html>`;
}

// Universal JSON-LD Unpacker for Client-Side Paywalls
function extractJsonLd(doc) {
    try {
        const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
        for (const script of scripts) {
            if (!script.textContent) continue;
            let data = null;
            try { data = JSON.parse(script.textContent); } catch (_) { continue; }

            const items = Array.isArray(data) ? data : [data];
            for (const item of items) {
                const graph = item['@graph'] || [item];
                for (const node of graph) {
                    if (node && node.articleBody && typeof node.articleBody === 'string' && node.articleBody.length > 300) {
                        const title = node.headline || node.name || 'Article';
                        const paragraphs = node.articleBody.split(/\n+/).map(p => `<p>${escapeHtml(p.trim())}</p>`).join('');
                        return { title, content: paragraphs };
                    }
                }
            }
        }
    } catch (_) {}
    return null;
}

// Archive.ph Proxy Fallback
async function fetchArchivePh(targetUrl, stripImages) {
    const archiveUrl = `https://archive.ph/newest/${targetUrl}`;
    const res = await fetch(`https://r.jina.ai/${archiveUrl}`, {
        headers: { 'X-No-Cache': 'true' },
        signal: AbortSignal.timeout(6000)
    });
    if (!res.ok) throw new Error('Archive fetch failed');
    const text = await res.text();
    if (!isValidContent(text)) throw new Error('Archive payload invalid');
    return buildKindleHTML('Archived Article', text, targetUrl, stripImages);
}

// Main Extraction Pipeline
async function executeBpcPipeline(targetUrl, stripImages) {
    const rule = getBpcRule(targetUrl);

    if (rule.strategy === 'archive_direct') {
        return await fetchArchivePh(targetUrl, stripImages);
    }

    const headers = {
        'User-Agent': UA_DESKTOP,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
    };

    if (rule.strategy === 'googlebot') {
        headers['User-Agent'] = UA_GOOGLEBOT;
        headers['Referer'] = 'https://www.google.com/';
    } else if (rule.strategy === 'bingbot') {
        headers['User-Agent'] = UA_BINGBOT;
    } else if (rule.strategy === 'twitter') {
        headers['User-Agent'] = UA_TWITTER;
        headers['Referer'] = 'https://t.co/';
    } else if (rule.strategy === 'facebook') {
        headers['Referer'] = 'https://www.facebook.com/';
    }

    const fetchOpts = { headers, signal: AbortSignal.timeout(4500) };
    if (rule.strategy === 'strip_cookies' || rule.strategy === 'googlebot') {
        fetchOpts.credentials = 'omit';
    }

    let html = '';
    try {
        const res = await fetch(targetUrl, fetchOpts);
        if (res.ok) html = await res.text();
    } catch (_) {}

    if (html) {
        const dom = parseHTML(html);
        const doc = dom.window.document;

        // Auto-Discover AMP alternative link
        const ampNode = doc.querySelector('link[rel="amphtml"]');
        if (ampNode && ampNode.getAttribute('href')) {
            try {
                const ampUrl = new URL(ampNode.getAttribute('href'), targetUrl).href;
                const ampRes = await fetch(ampUrl, { headers: { 'User-Agent': UA_DESKTOP }, signal: AbortSignal.timeout(3500) });
                if (ampRes.ok) {
                    const ampHtml = await ampRes.text();
                    const ampDom = parseHTML(ampHtml);
                    const reader = new Readability(ampDom.window.document);
                    const article = reader.parse();
                    if (article && isValidContent(article.content)) {
                        return buildKindleHTML(article.title, article.content, targetUrl, stripImages);
                    }
                }
            } catch (_) {}
        }

        // Strategy A: Direct Readability Parse
        const reader = new Readability(doc);
        const article = reader.parse();
        if (article && isValidContent(article.content)) {
            return buildKindleHTML(article.title, article.content, targetUrl, stripImages);
        }

        // Strategy B: Embedded JSON-LD Extract
        const jsonLd = extractJsonLd(doc);
        if (jsonLd && isValidContent(jsonLd.content)) {
            return buildKindleHTML(jsonLd.title, jsonLd.content, targetUrl, stripImages);
        }
    }

    // Remote JS Execution Fallback (Jina AI)
    try {
        const jinaRes = await fetch(`https://r.jina.ai/${targetUrl}`, {
            headers: { 'X-No-Cache': 'true', 'X-Return-Format': 'html' },
            signal: AbortSignal.timeout(7000)
        });
        if (jinaRes.ok) {
            const jinaHtml = await jinaRes.text();
            if (isValidContent(jinaHtml)) {
                return buildKindleHTML('Article', jinaHtml, targetUrl, stripImages);
            }
        }
    } catch (_) {}

    // Final Fallback: Archive.ph Mirror
    return await fetchArchivePh(targetUrl, stripImages);
}

// Server Routes
app.get('/extract', async (req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8');

    const targetUrl = sanitizeUrl(req.query.url);
    if (!targetUrl) return res.status(400).send('Invalid URL');

    const stripImages = req.query.no_images === 'true' || req.query.no_images === '1';
    const cacheKey = stripImages ? `${targetUrl}#no_img` : targetUrl;

    const cached = articleCache.get(cacheKey);
    if (cached) return res.send(cached);

    try {
        const result = await executeBpcPipeline(targetUrl, stripImages);
        articleCache.set(cacheKey, result);
        return res.send(result);
    } catch (err) {
        return res.status(500).send('Failed to extract article content.');
    }
});

app.listen(PORT, () => console.log(`BPC Server running on port ${PORT}`));
