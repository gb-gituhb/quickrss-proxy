const fs = require('fs');
const path = require('path');

const sitesJsPath = path.join(__dirname, 'sites.js');
const outputPath = path.join(__dirname, 'bpc-rules.json');

if (!fs.existsSync(sitesJsPath)) {
  console.warn('[BUILD] sites.js not found. Generating minimal bpc-rules.json skeleton...');
  const fallback = {
    domains: ["nytimes.com", "wsj.com", "washingtonpost.com", "economist.com"],
    archiveDomains: ["bloomberg.com", "ft.com", "barrons.com"],
    sitesMap: {}
  };
  fs.writeFileSync(outputPath, JSON.stringify(fallback, null, 2));
  process.exit(0);
}

try {
  const content = fs.readFileSync(sitesJsPath, 'utf-8');
  const domains = [];
  const archiveDomains = [];
  const sitesMap = {};

  // Extract site domains from BPC format
  const domainRegex = /['"]([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})['"]/g;
  let match;
  while ((match = domainRegex.exec(content)) !== null) {
    const domain = match[1].toLowerCase().replace(/^www\./, '');
    if (!domains.includes(domain) && !domain.endsWith('.js') && !domain.endsWith('.json')) {
      domains.push(domain);
      
      // Identify archive-forced rules inside sites.js
      if (content.includes(`"${domain}"`) && content.toLowerCase().includes('archive')) {
        archiveDomains.push(domain);
      }
      sitesMap[domain] = { domain };
    }
  }

  const outputData = { domains, archiveDomains, sitesMap };
  fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2));
  console.log(`[BUILD] Generated bpc-rules.json with ${domains.length} domains (${archiveDomains.length} archive-flagged).`);
} catch (err) {
  console.error('[BUILD] Error compiling bpc-rules.json:', err);
}
