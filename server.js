const express = require('express');
const { parseHTML } = require('linkedom');
const { Readability } = require('@mozilla/readability');

const app = express();
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.send('QuickRSS Kindle Proxy is Active.');
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

    const html = await response.text();
    const { document } = parseHTML(html);

    // Fix relative links/images
    const base = document.createElement('base');
    base.href = targetUrl;
    document.head.appendChild(base);

    // Parse main article content via Mozilla Readability
    const reader = new Readability(document);
    const article = reader.parse();

    if (!article || !article.content) {
      return res.status(500).send('Failed to extract article body.');
    }

    // Clean, high-contrast Kindle E-Ink HTML layout
    const cleanDocument = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${article.title || 'Article'}</title>
        <base href="${targetUrl}">
        <style>
          body {
            font-family: Georgia, "Times New Roman", serif;
            line-height: 1.6;
            max-width: 680px;
            margin: 0 auto;
            padding: 15px;
            color: #000;
            background-color: #fff;
          }
          h1 { font-size: 1.8em; line-height: 1.2; margin-bottom: 0.3em; }
          .byline { font-style: italic; color: #333; margin-bottom: 1.5em; border-bottom: 1px solid #000; padding-bottom: 8px; font-size: 0.95em; }
          img { max-width: 100%; height: auto; display: block; margin: 15px auto; }
          p { margin-bottom: 1.2em; font-size: 1.05em; }
          a { color: #000; text-decoration: underline; }
          blockquote { border-left: 3px solid #000; margin: 1.5em 0; padding-left: 15px; font-style: italic; }
        </style>
      </head>
      <body>
        <h1>${article.title || ''}</h1>
        ${article.byline ? `<div class="byline">${article.byline}</div>` : ''}
        ${article.content}
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
