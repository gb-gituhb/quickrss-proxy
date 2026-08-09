const express = require('express');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8080;
const BPC_PATH = path.join(__dirname, 'bpc-extension');

function cleanHtml(html) {
  const $ = cheerio.load(html);
  $('script, style, nav, footer, iframe, header, form, svg, noscript, .ad, .advertisement, [id*="cookie"], [class*="cookie"]').remove();
  return $.html();
}

async function extractWithPuppeteer(url) {
  const hasBpc = fs.existsSync(BPC_PATH);
  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-zygote',
    '--single-process'
  ];

  if (hasBpc) {
    launchArgs.push(`--disable-extensions-except=${BPC_PATH}`);
    launchArgs.push(`--load-extension=${BPC_PATH}`);
  }

  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXEC_PATH || undefined,
    headless: 'new',
    args: launchArgs
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await new Promise(resolve => setTimeout(resolve, 2000));

    const content = await page.content();
    await browser.close();

    const lowered = content.toLowerCase();
    const isPaywalled = lowered.includes('subscribe_wall') || 
                        lowered.includes('paywall') || 
                        lowered.includes('register to read') || 
                        lowered.includes('access-restricted');

    if (content.length > 2500 && !isPaywalled) {
      return cleanHtml(content);
    }
  } catch (err) {
    console.error('Puppeteer Stage Error:', err.message);
    await browser.close();
  }
  return null;
}

async function extractArchive(url) {
  const archiveUrl = `https://archive.ph/newest/${url}`;
  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXEC_PATH || undefined,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  try {
    const page = await browser.newPage();
    await page.goto(archiveUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const content = await page.content();
    await browser.close();

    if (content && content.length > 1500 && !content.toLowerCase().includes('captcha')) {
      return cleanHtml(content);
    }
  } catch (err) {
    console.error('Archive Stage Error:', err.message);
    await browser.close();
  }
  return null;
}

async function extractMorss(url) {
  try {
    const response = await fetch(`https://morss.it/${url}`);
    if (response.ok) {
      const text = await response.text();
      return cleanHtml(text);
    }
  } catch (err) {
    console.error('Morss Stage Error:', err.message);
  }
  return null;
}

app.get('/extract', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).send('Missing ?url= parameter');
  }

  console.log(`Extracting: ${targetUrl}`);

  let html = await extractWithPuppeteer(targetUrl);
  if (html) {
    console.log('Stage 1 (BPC) succeeded');
    return res.setHeader('Content-Type', 'text/html').send(html);
  }

  console.log('Stage 1 failed. Attempting Stage 2 (Archive.ph)...');
  html = await extractArchive(targetUrl);
  if (html) {
    console.log('Stage 2 (Archive.ph) succeeded');
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

app.listen(PORT, () => {
  console.log(`BPC Cloud Proxy listening on port ${PORT}`);
});
