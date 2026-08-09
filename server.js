const express = require('express');
const { Readability } = require('@mozilla/readability');
const { parseHTML } = require('linkedom');
const { marked } = require('marked');

const app = express();
const PORT = process.env.PORT || 3000;
const JINA_API_KEY = process.env.JINA_API_KEY || '';

// Wrap content in Kindle Paperwhite Charis SIL typography
function buildKindleHTML(title, content) {
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
    ${content}
</body>
</html>`;
}

function getJinaHeaders() {
    const headers = { 'Accept': 'application/json' };
    if (JINA_API_KEY) headers['Authorization'] = `Bearer ${JINA_API_KEY}`;
    return headers;
}

function isValidContent(text) {
    if (!text || text.length < 400) return false;
    const lower = text.toLowerCase();
    const errorKeywords = ['captcha', 'enable javascript', 'access denied', 'subscribe to read', 'no snapshot', 'security check'];
    return !errorKeywords.some(keyword => lower.includes(keyword));
}

// Tier 1: Direct Fetch (6s Timeout - Googlebot Referer + High TTFB Buffer)
async function fetchDirect(targetUrl) {
    const response = await fetch(targetUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Referer': 'https://www.google.com/'
        },
        signal: AbortSignal.timeout(6000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();

    const dom = parseHTML(html);
    const doc = dom.window.document;
    const base = doc.createElement('base');
    base.href = targetUrl;
    doc.head.appendChild(base);

    const reader = new Readability(doc);
    const article = reader.parse();

    if (!article || !isValidContent(article.content)) {
        throw new Error('Direct fetch content invalid or paywalled');
    }
    return buildKindleHTML(article.title, article.content);
}

// Tier 2: Live Anti-Bot Middleware (18s Timeout - Generous buffer for JS rendering & Cloudflare)
async function fetchViaLiveMiddleware(targetUrl) {
    const response = await fetch(`https://r.jina.ai/${targetUrl}`, {
        headers: getJinaHeaders(),
        signal: AbortSignal.timeout(18000)
    });
    if (!response.ok) throw new Error(`Jina Live HTTP ${response.status}`);
    
    const json = await response.json();
    if (!json.data || !json.data.content) throw new Error('Jina Live payload empty');

    const htmlContent = await marked.parse(json.data.content);
    if (!isValidContent(htmlContent)) throw new Error('Jina Live content invalid or paywalled');

    return buildKindleHTML(json.data.title || 'Article', htmlContent);
}

// Tier 3: archive.ph via Middleware (20s Timeout - Maximum buffer for archive redirects & heavy DOM)
async function fetchViaArchivePh(targetUrl) {
    const archivePhUrl = `https://archive.ph/newest/${targetUrl}`;
    const response = await fetch(`https://r.jina.ai/${archivePhUrl}`, {
        headers: getJinaHeaders(),
        signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) throw new Error(`archive.ph HTTP ${response.status}`);

    const json = await response.json();
    if (!json.data || !json.data.content) throw new Error('archive.ph payload empty');

    const htmlContent = await marked.parse(json.data.content);
    if (!isValidContent(htmlContent)) throw new Error('archive.ph snapshot not found or blocked');

    return buildKindleHTML(json.data.title || 'Archived Article', htmlContent);
}

// Tier 4: Wayback Machine Fallback (8s Timeout - Generous API check)
async function fetchViaWayback(targetUrl) {
    const apiRes = await fetch(`https://archive.org/wayback/available?url=${encodeURIComponent(targetUrl)}`, {
        signal: AbortSignal.timeout(8000)
    });
    const apiData = await apiRes.json();
    const snapshotUrl = apiData?.archived_snapshots?.closest?.url;
    if (!snapshotUrl) throw new Error('No Wayback snapshot available');

    return await fetchDirect(snapshotUrl);
}

// Extraction Route
app.get('/extract', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Missing url parameter');

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
