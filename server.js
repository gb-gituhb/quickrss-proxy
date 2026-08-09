const express = require('express');
const { Readability } = require('@mozilla/readability');
const { parseHTML } = require('linkedom');
const { marked } = require('marked');

const app = express();
const PORT = process.env.PORT || 3000;

// Helper: Wrap content in Kindle Paperwhite Charis SIL typography
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

// Tier 1: Direct Fetch + Readability
async function fetchDirect(targetUrl) {
    const response = await fetch(targetUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        }
    });

    if (!response.ok) throw new Error(`HTTP Error ${response.status}`);
    const html = await response.text();

    const dom = parseHTML(html);
    const doc = dom.window.document;

    // Fix relative image and link paths
    const base = doc.createElement('base');
    base.href = targetUrl;
    doc.head.appendChild(base);

    const reader = new Readability(doc);
    const article = reader.parse();

    if (!article || !article.content || article.content.length < 300) {
        throw new Error('Content too short or paywall detected');
    }

    return buildKindleHTML(article.title, article.content);
}

// Tier 2: Anti-Bot Middleware (Bypasses Paywalls & Cloudflare CAPTCHAs)
async function fetchViaMiddleware(targetUrl) {
    const middlewareUrl = `https://r.jina.ai/${targetUrl}`;
    const response = await fetch(middlewareUrl, {
        headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) throw new Error(`Middleware HTTP Error ${response.status}`);
    const json = await response.json();

    if (!json.data || !json.data.content) throw new Error('Middleware payload empty');

    // Convert markdown content to clean HTML
    const htmlContent = marked.parse(json.data.content);
    return buildKindleHTML(json.data.title || 'Article', htmlContent);
}

// Tier 3: Internet Archive / Wayback Machine Fallback
async function fetchViaWayback(targetUrl) {
    const archiveApi = `https://archive.org/wayback/available?url=${encodeURIComponent(targetUrl)}`;
    const apiRes = await fetch(archiveApi);
    const apiData = await apiRes.json();

    const snapshotUrl = apiData?.archived_snapshots?.closest?.url;
    if (!snapshotUrl) throw new Error('No archived snapshot available');

    return await fetchDirect(snapshotUrl);
}

// Extraction Route
app.get('/extract', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Missing url parameter');

    // Attempt 1: Direct Fetch
    try {
        const html = await fetchDirect(targetUrl);
        return res.send(html);
    } catch (err) {
        console.warn(`[Tier 1 Failed] ${targetUrl}: ${err.message}. Trying Tier 2 Middleware...`);
    }

    // Attempt 2: Anti-Bot Middleware (Paywall & Cloudflare Bypass)
    try {
        const html = await fetchViaMiddleware(targetUrl);
        return res.send(html);
    } catch (err) {
        console.warn(`[Tier 2 Failed] ${targetUrl}: ${err.message}. Trying Tier 3 Wayback Archive...`);
    }

    // Attempt 3: Wayback Archive
    try {
        const html = await fetchViaWayback(targetUrl);
        return res.send(html);
    } catch (err) {
        console.error(`[Tier 3 Failed] ${targetUrl}: ${err.message}`);
        return res.status(500).send('Failed to extract article content across all pipelines.');
    }
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
