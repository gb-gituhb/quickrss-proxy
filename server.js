const express = require('express');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.send('QuickRSS Proxy is active.');
});

app.get('/extract', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).send('Missing url parameter');
  }

  console.log(`Extracting: ${targetUrl}`);

  try {
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      }
    });

    const text = await response.text();
    const $ = cheerio.load(text);
    $('script, style, nav, footer, iframe, header, noscript, .ad').remove();
    const cleaned = $.html();

    return res.setHeader('Content-Type', 'text/html').send(cleaned || text);
  } catch (err) {
    console.error('Fetch error:', err.message);
    return res.status(500).send(`Proxy fetch failed: ${err.message}`);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
