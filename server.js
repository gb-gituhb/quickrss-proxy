const express = require('express');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.send('QuickRSS Proxy is Running!');
});

app.get('/extract', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing ?url= parameter');

  console.log('Extracting:', targetUrl);
  try {
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      }
    });
    const htmlText = await response.text();
    const $ = cheerio.load(htmlText);

    // Remove site navigation, headers, footers, sidebars, and ads
    $('script, style, nav, footer, header, iframe, noscript, .ad, .advertisement, [id*="cookie"], [class*="cookie"], [class*="paywall"], #mw-navigation, #mw-head, #mw-panel, .vector-header, .vector-sidebar').remove();

    // Isolate main article content container if present
    const mainContent = $('article, main, #content, .post-content, .entry-content, #mw-content-text').first();
    const bodyHtml = mainContent.length > 0 ? mainContent.html() : $('body').html();
    const pageTitle = $('title').text() || 'Article';

    // Construct clean, styled Reader Mode document
    const cleanDocument = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${pageTitle}</title>
        <base href="${targetUrl}">
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            line-height: 1.6;
            max-width: 720px;
            margin: 0 auto;
            padding: 20px;
            color: #111;
            background-color: #fff;
          }
          img { max-width: 100%; height: auto; display: block; margin: 15px auto; }
          a { color: #0066cc; text-decoration: underline; }
          h1, h2, h3 { line-height: 1.3; margin-top: 1.5em; }
          table { width: 100%; border-collapse: collapse; margin: 15px 0; overflow-x: auto; display: block; }
          th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
          blockquote { border-left: 4px solid #ccc; margin: 0; padding-left: 16px; color: #555; }
        </style>
      </head>
      <body>
        ${bodyHtml}
      </body>
      </html>
    `;

    return res.setHeader('Content-Type', 'text/html').send(cleanDocument);
  } catch (err) {
    console.error('Fetch error:', err.message);
    return res.status(500).send('Fetch error: ' + err.message);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
