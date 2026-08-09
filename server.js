const express = require('express');
const { Readability } = require('@mozilla/readability');
const { parseHTML } = require('linkedom');
const { marked } = require('marked');

const app = express();
const PORT = process.env.PORT || 3000;
const JINA_API_KEY = process.env.JINA_API_KEY || '';

// Clean out QuickRSS tracking prefixes, trailing quotes, and extract valid URLs
function sanitizeUrl(rawUrl) {
    if (!rawUrl) return null;
    
    // Take the last item if Express parsed an array, cast to string, trim quotes and whitespace
    let urlString = Array.isArray(rawUrl) ? String(rawUrl[rawUrl.length - 1]) : String(rawUrl);
    urlString = urlString.trim().replace(/^['"]|['"]$/g, '');

    const match = urlString.match(/(https?:\/\/[^\s'"]+)/i);
    return match ? match[1] : null;
}

// DOM-based image sanitizer: fixes lazy loading, resolves relative URLs, strips srcset & tracking pixels
function sanitizeImages(htmlContent, targetUrl) {
    if (!htmlContent) return '';
    
    try {
        const dom = parseHTML(`<div>${htmlContent}</div>`);
        const doc = dom.window.document;
        const imgs = doc.querySelectorAll('img');

        imgs.forEach(img => {
            // 1. Swap lazy-load attributes to src if src is missing or a placeholder/data URI
            const realSrc = img.getAttribute('data-src') || 
                            img.getAttribute('data-original') || 
                            img.getAttribute('data-lazy-src') || 
                            img.getAttribute('src');

            if (!realSrc || realSrc.startsWith('data:')) {
                img.remove();
                return;
            }

            // 2. Strip 1x1 tracking pixels that stall Kindle downloads
            const width = img.getAttribute('width');
            const height = img.getAttribute('height');
            if ((width === '1' || width === '0') && (height === '1' || height === '0')) {
                img.remove();
                return;
            }

            // 3. Resolve absolute URL for relative paths (/img.jpg, ./img.jpg, //cdn.com/img.jpg)
            try {
                const absUrl = new URL(realSrc, targetUrl).href;
                img.setAttribute('src', absUrl);
            } catch (_) {
                img.remove();
                return;
            }

            // 4. Remove attributes that cause Kindle cURL stalls
            img.removeAttribute('data-src');
            img.removeAttribute('data-original');
            img.removeAttribute('data-lazy-src');
            img.removeAttribute('srcset'); // Removes multi-resolution duplicate downloads
        });

        return doc.body.firstElementChild ? doc.body.firstElementChild.innerHTML : htmlContent;
    } catch (e) {
        return htmlContent;
    }
}

// Wrap content in Kindle Paperwhite Charis SIL typography
function buildKindleHTML(title, content, targetUrl = '') {
    const cleanedContent = targetUrl ? sanitizeImages(content, targetUrl) : content;
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title || 'Article'}</title>
    <style>
        @font-face {
            font-family: 'Charis SIL';
            src: local('Charis SIL');
        }
        body {
            font-family: 'Charis SIL', Georgia, serif;
            line-height: 1.6;
            color: #000;
            background-color: #fff;
            margin: 0 auto;
            max-width: 680px;
            padding: 15px;
            font-size: 1.1em;
        }
        h1 { font-size: 1.7em; margin-bottom: 0.2em; }
        img { max-width: 100%; height: auto; display: block; margin: 15px auto; }
        p { margin-bottom: 1.2em; text-align: justify; }
        a { color: #000; text-decoration: underline; }
        blockquote { border-left: 3px solid #000; padding-left: 10px; margin-left: 0; }
    </style>
</head>
<body>
    <h1>${title || 'Untitled'}</h1>
    <hr>
    ${cleanedContent}
</body>
</html>`;
}

function getJinaHeaders() {
    const headers = { 
        'Accept': 'application/json',
        'X-No-Cache': 'true'
    };
    if (JINA_API_KEY) headers['Authorization'] = `Bearer ${JINA_API_KEY}`;
    return headers;
}

function isValidContent(text) {
    if (!text || text.trim().length < 200) return false;
    const lower = text.toLowerCase();
    
    // 1. Hard bot-blocker errors
    const hardErrors = [
        'captcha', 'enable javascript', 'access denied', 
        'security check', 'just a moment...', 'pardon our interruption',
        'enable cookies', 'cf-browser-verification'
    ];
    if (hardErrors.some(keyword => lower.includes(keyword))) {
        return false;
    }

    // 2. Truncation, teaser, & paywall phrases (forces failover to Jina/Archive for incomplete articles)
    const truncationMarkers = [
        'continue reading', 'read full story', 'read full article', 
        'read the full article', 'keep reading', 'subscribe to read', 
        'no snapshot', 'create an account to read', 'log in to read', 
        'sign in to continue', 'register to read', 'read more'
    ];

    if (truncationMarkers.some(keyword => lower.includes(keyword)) && text.length < 3000) {
        return false;
    }

    // 3. Reject anything under 500 characters
    if (text.length < 500) {
        return false;
    }

    return true;
}

// Tier 1: Direct Fetch (5s Timeout)
async function fetchDirect(targetUrl) {
    const response = await fetch(targetUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Referer': 'https://www.google.com/'
        },
        signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();

    if (!html || html.trim().length < 200) {
        throw new Error('Received empty or invalid HTML payload');
    }

    const dom = parseHTML(html);
    const doc = dom?.window?.document;
    if (!doc || !doc.documentElement) {
        throw new Error('Failed to parse valid DOM structure');
    }

    if (doc.head) {
        const base = doc.createElement('base');
        base.href = targetUrl;
        doc.head.appendChild(base);
    }

    const reader = new Readability(doc);
    const article = reader.parse();

    if (!article || !article.content || !isValidContent(article.content)) {
        throw new Error('Direct fetch content invalid, truncated, or paywalled');
    }
    return buildKindleHTML(article.title, article.content, targetUrl);
}

// Tier 2: Live Anti-Bot Middleware (10s Timeout)
async function fetchViaLiveMiddleware(targetUrl) {
    const response = await fetch(`https://r.jina.ai/${targetUrl}`, {
        headers: getJinaHeaders(),
        signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error(`Jina Live HTTP ${response.status}`);
    
    const json = await response.json();
    if (!json.data || !json.data.content) throw new Error('Jina Live payload empty');

    const htmlContent = await marked.parse(json.data.content);
    if (!isValidContent(htmlContent)) throw new Error('Jina Live content invalid or paywalled');

    return buildKindleHTML(json.data.title || 'Article', htmlContent, targetUrl);
}

// Tier 3: archive.ph via Middleware (12s Timeout)
async function fetchViaArchivePh(targetUrl) {
    const archivePhUrl = `https://archive.ph/newest/${targetUrl}`;
    const response = await fetch(`https://r.jina.ai/${archivePhUrl}`, {
        headers: getJinaHeaders(),
        signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) throw new Error(`archive.ph HTTP ${response.status}`);

    const json = await response.json();
    if (!json.data || !json.data.content) throw new Error('archive.ph payload empty');

    const htmlContent = await marked.parse(json.data.content);
    if (!isValidContent(htmlContent)) throw new Error('archive.ph snapshot not found or blocked');

    return buildKindleHTML(json.data.title || 'Archived Article', htmlContent, targetUrl);
}

// Tier 4: Wayback Machine Fallback (5s Timeout)
async function fetchViaWayback(targetUrl) {
    const apiRes = await fetch(`https://archive.org/wayback/available?url=${encodeURIComponent(targetUrl)}`, {
        signal: AbortSignal.timeout(5000)
    });
    
    if (!apiRes.ok) throw new Error(`Wayback API HTTP ${apiRes.status}`);
    const contentType = apiRes.headers.get('content-type') || '';
    if (!contentType.includes('json')) throw new Error('Wayback API returned non-JSON payload');

    const apiData = await apiRes.json();
    const snapshotUrl = apiData?.archived_snapshots?.closest?.url;
    if (!snapshotUrl) throw new Error('No Wayback snapshot available');

    return await fetchDirect(snapshotUrl);
}

// Health Check Route (used by UptimeRobot to keep Render warm 24/7)
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Main Extraction Route
app.get('/extract', async (req, res) => {
    const rawUrl = req.query.url;
    if (!rawUrl) return res.status(400).send('Missing url parameter');

    const targetUrl = sanitizeUrl(rawUrl);

    if (!targetUrl) {
        return res.status(400).send('Invalid or malformed URL provided.');
    }

    try {
        return res.send(await fetchDirect(targetUrl));
    } catch (e1) {
        console.warn(`[Tier 1 Failed] ${targetUrl}: ${e1.message}. Trying Tier 2 (Live Jina)...`);
    }

    try {
        return res.send(await fetchViaLiveMiddleware(targetUrl));
    } catch (e2) {
        console.warn(`[Tier 2 Failed] ${targetUrl}: ${e2.message}. Trying Tier 3 (archive.ph)...`);
    }

    try {
        return res.send(await fetchViaArchivePh(targetUrl));
    } catch (e3) {
        console.warn(`[Tier 3 Failed] ${targetUrl}: ${e3.message}. Trying Tier 4 (Wayback)...`);
    }

    try {
        return res.send(await fetchViaWayback(targetUrl));
    } catch (e4) {
        console.error(`[Tier 4 Failed] ${targetUrl}: ${e4.message}`);
        return res.status(500).send('Failed to extract article content across all pipelines.');
    }
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
