const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Load or build BPC rules
const rulesPath = path.join(__dirname, 'bpc-rules.json');
let bpcRules = { sitesMap: {}, domains: [], archiveDomains: [] };

function loadRules() {
  if (fs.existsSync(rulesPath)) {
    bpcRules = JSON.parse(fs.readFileSync(rulesPath, 'utf-8'));
    console.log(`[SERVER] Loaded BPC Rules with ${bpcRules.totalDomains || 0} active domains.`);
  } else {
    console.warn('[SERVER] bpc-rules.json not found. Running build-bpc-rules.js...');
    require('./build-bpc-rules.js');
    if (fs.existsSync(rulesPath)) {
      bpcRules = JSON.parse(fs.readFileSync(rulesPath, 'utf-8'));
    }
  }
}

loadRules();

// Helper: Check if domain is listed
function matchDomain(targetUrl) {
  try {
    const hostname = new URL(targetUrl).hostname.replace(/^www\./, '');
    const isArchive = bpcRules.archiveDomains.includes(hostname);
    const isSupported = bpcRules.domains.includes(hostname);
    return { hostname, isSupported, isArchive };
  } catch (e) {
    return { hostname: '', isSupported: false, isArchive: false };
  }
}

// QuickRSS Proxy Endpoint
app.get('/proxy', (req, res) => {
  const targetUrl = req.query.url;

  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  const { hostname, isSupported, isArchive } = matchDomain(targetUrl);

  let fetchUrl = targetUrl;
  if (isArchive) {
    fetchUrl = `https://archive.is/newest/${encodeURIComponent(targetUrl)}`;
  }

  // Header Spoofing for Bypass
  const headers = {
    'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Referer': 'https://www.google.com/',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9'
  };

  const client = fetchUrl.startsWith('https') ? https : http;

  const proxyReq = client.get(fetchUrl, { headers }, (upstreamRes) => {
    // Pass through status and content-type
    res.status(upstreamRes.statusCode);
    res.setHeader('Content-Type', upstreamRes.headers['content-type'] || 'text/html');
    res.setHeader('X-QuickRSS-Matched-Domain', hostname);
    res.setHeader('X-QuickRSS-Bypass-Status', isSupported ? 'active' : 'passthrough');

    upstreamRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    res.status(500).json({ error: 'Proxy request failed', message: err.message });
  });
});

// API Routes
app.get('/api/domains', (req, res) => {
  res.json({
    total: bpcRules.domains.length,
    domains: bpcRules.domains
  });
});

app.get('/api/sites', (req, res) => {
  res.json(bpcRules.sitesMap);
});

app.get('/api/check', (req, res) => {
  const targetDomain = (req.query.domain || '').toLowerCase().replace(/^www\./, '');
  const isSupported = bpcRules.domains.includes(targetDomain);
  res.json({
    domain: targetDomain,
    supported: isSupported,
    requiresArchive: bpcRules.archiveDomains.includes(targetDomain)
  });
});

app.get('/', (req, res) => {
  res.json({
    name: 'quickrss-proxy',
    status: 'running',
    rulesLoaded: bpcRules.totalDomains || 0
  });
});

app.listen(PORT, () => {
  console.log(`QuickRSS Proxy listening on port ${PORT}`);
});
