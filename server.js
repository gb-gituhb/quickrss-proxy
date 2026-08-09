const express = require('express');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 10000;

function cleanHtml(html) {
  if (!html) return null;
  const $ = cheerio.load(html);
  $('script, style, nav, footer, iframe, header, form, svg, noscript, .ad, .advertisement, [id*="cookie"], [class*="cookie"], [class*="paywall"]').remove();
  return $.html();
}

// Stage 1: Direct Fetch with browser headers
async function extractDirect(url) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      signal: AbortSignal.timeout(8000)
    });
    if (response.ok) {
      const text = await response.text();
      const cleaned = cleanHtml(text);
      const lowered = text.toLowerCase();
      const isPaywalled = lowered.includes('subscribe_wall') || 
                          lowered.includes('paywall') || 
                          lowered.includes('register to read');
      if (cleaned && cleaned.length > 1000 && !isPaywalled) {
        return cleaned;
      }
    }
  } catch (err) {
    console.error('Direct stage error:', err.message);
  }
  return null;
}

// Stage 2: Archive.ph bypass
async function extractArchive(url) {
  try {
    const response = await fetch(`https://archive.ph/newest/${url}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000)
    });
    if (response.ok) {
      const text = await response.text();
      if (text && text.length > 1500 && !text.toLowerCase().includes('captcha')) {
        return cleanHtml(text);
      }
    }
  } catch (err) {
    console.error('Archive stage error:', err.message);
  }
  return null;
}

// Stage 3: Morss RSS extractor
async function extractMorss(url) {
  try {
    const response = await fetch(`https://morss.it/${url}`, {
      signal: AbortSignal.timeout(10000)
    });
    if (response.ok) {
      const text = await response.text();
      if (text && text.length > 500) {
        return cleanHtml(text);
      }
    }
  } catch (err) {
    console.error('Morss stage error:', err.message);
  }
  return null;
}

app.get('/', (req, res) => {
  res.send('QuickRSS BPC Proxy is Running. Usage: /extract?url=HTTPS_ARTICLE_URL');
});

app.get('/extract', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).send('Missing ?url= parameter');
  }

  console.log(`Extracting: ${targetUrl}`);

  let html = await extractDirect(targetUrl);
  if (html) {
    console.log('Stage 1 (Direct) succeeded');
    return res.setHeader('Content-Type', 'text/html').send(html);
  }

  console.log('Stage 1 failed. Attempting Stage 2 (Archive.ph)...');
  html = await extractArchive(targetUrl);
  if (html) {
    console.log('Stage 2 (Archive) succeeded');
    return res.setHeader('Content-Type', 'text/html').send(html);
  }

  console.log('Stage 2 failed. Attempting Stage 3 (Morss)...');
  html = await extractMorss(targetUrl);
  if (html) {
    console.log('Stage 3 (Morss) succeeded');
    return res.setHeader('Content-Type', 'text/html').send(html);
  }

  return res.status(500).send('Extraction failed across all stages.');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`BPC Cloud Proxy listening on port ${PORT}`);
});
