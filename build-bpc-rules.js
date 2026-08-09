const fs = require('fs');
const path = require('path');

/**
 * Builds site mapping rules and paywall domain definitions for tier routing.
 */
function buildBpcRules() {
  const extractedDomains = new Set();
  const extractedArchiveDomains = new Set();
  const sitesMap = {};

  // Default hard paywall domains routed directly to archive extraction
  const HARD_PAYWALL_DOMAINS = [
    'economist.com',
    'ft.com',
    'wsj.com',
    'bloomberg.com',
    'nytimes.com',
    'barrons.com',
    'telegraph.co.uk',
    'businessinsider.com'
  ];

  HARD_PAYWALL_DOMAINS.forEach(domain => {
    extractedArchiveDomains.add(domain);
    extractedDomains.add(domain);
  });

  const output = {
    domains: Array.from(extractedDomains),
    archiveDomains: Array.from(extractedArchiveDomains),
    sitesMap
  };

  const outputPath = path.join(__dirname, 'bpc-rules.json');
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`Successfully generated ${outputPath} with ${output.domains.length} domains (${output.archiveDomains.length} archive-first).`);
}

if (require.main === module) {
  buildBpcRules();
}

module.exports = buildBpcRules;
