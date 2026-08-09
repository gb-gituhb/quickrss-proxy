const fs = require('fs');
const path = require('path');

const sitesJsPath = path.join(__dirname, 'sites.js');
const outputPath = path.join(__dirname, 'bpc-rules.json');

// Default fallback configuration if sites.js is absent
const fallbackConfig = {
  domains: [
    "nytimes.com",
    "wsj.com",
    "washingtonpost.com",
    "economist.com",
    "bloomberg.com",
    "ft.com",
    "barrons.com"
  ],
  archiveDomains: [
    "bloomberg.com",
    "ft.com",
    "barrons.com"
  ],
  sitesMap: {
    "economist.com": { "stripImages": true, "timeoutMs": 3500 },
    "ft.com": { "stripImages": true },
    "wsj.com": { "useragent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" }
  }
};

if (!fs.existsSync(sitesJsPath)) {
  console.warn('[BUILD] sites.js not found. Generating default bpc-rules.json...');
  fs.writeFileSync(outputPath, JSON.stringify(fallbackConfig, null, 2));
  console.log('[BUILD] Created fallback bpc-rules.json successfully.');
  process.exit(0);
}

try {
  const content = fs.readFileSync(sitesJsPath, 'utf-8');
  const domainsSet = new Set();
  const archiveDomainsSet = new Set();
  const sitesMap = {};

  // Regex to extract domain strings from sites.js definitions
  const domainRegex = /['"]([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})['"]/g;
  let match;

  while ((match = domainRegex.exec(content)) !== null) {
    const domain = match[1].toLowerCase().replace(/^www\./, '');
    
    // Ignore script/json file extensions accidentally matched
    if (!domain.endsWith('.js') && !domain.endsWith('.json')) {
      domainsSet.add(domain);

      // Check if domain in sites.js triggers archive redirects/rules
      const domainBlockRegex = new RegExp(`"${domain}"[\\s\\S]*?\\}`, 'i');
      const blockMatch = content.match(domainBlockRegex);

      if (blockMatch && blockMatch[0].toLowerCase().includes('archive')) {
        archiveDomainsSet.add(domain);
      }

      // Initialize site rule object
      sitesMap[domain] = {
        domain: domain
      };
    }
  }

  // Example manually defined overrides for specific heavy news sites
  if (sitesMap['economist.com']) sitesMap['economist.com'].stripImages = true;
  if (sitesMap['ft.com']) sitesMap['ft.com'].stripImages = true;

  const outputData = {
    domains: Array.from(domainsSet),
    archiveDomains: Array.from(archiveDomainsSet),
    sitesMap: sitesMap
  };

  fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2));
  console.log(`[BUILD] Generated bpc-rules.json with ${outputData.domains.length} domains (${outputData.archiveDomains.length} archive-flagged).`);
} catch (err) {
  console.error('[BUILD] Error compiling bpc-rules.json:', err.message);
  process.exit(1);
}
