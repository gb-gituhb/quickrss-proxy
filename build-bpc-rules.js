const fs = require('fs');
const path = require('path');

console.log('[BUILD] Starting BPC rules compilation...');

const sitesPath = path.join(__dirname, 'bpc-extension', 'sites.js');
const outputPath = path.join(__dirname, 'bpc-rules.json');

try {
  if (!fs.existsSync(sitesPath)) {
    throw new Error(`Could not find sites.js at ${sitesPath}`);
  }

  // Load sites.js
  const { defaultSites, defaultDomains } = require(sitesPath);

  // Filter out internal non-domain placeholders (e.g. ###_group_rules)
  const cleanSitesMap = {};
  for (const [siteName, domain] of Object.entries(defaultSites)) {
    if (!domain.startsWith('###')) {
      cleanSitesMap[siteName] = domain;
    }
  }

  // Identify sites requiring archive.is fetches
  const archiveRequiredDomains = Object.entries(cleanSitesMap)
    .filter(([siteName]) => siteName.toLowerCase().includes('fetch from archive.is'))
    .map(([_, domain]) => domain);

  const compiledRules = {
    generatedAt: new Date().toISOString(),
    totalSites: Object.keys(cleanSitesMap).length,
    totalDomains: defaultDomains.length,
    sitesMap: cleanSitesMap,
    domains: defaultDomains,
    archiveDomains: archiveRequiredDomains
  };

  fs.writeFileSync(outputPath, JSON.stringify(compiledRules, null, 2), 'utf-8');
  console.log(`[BUILD] Successfully built ${compiledRules.totalDomains} domain rules -> bpc-rules.json`);

} catch (err) {
  console.error('[BUILD ERROR]', err.message);
  process.exit(1);
}
