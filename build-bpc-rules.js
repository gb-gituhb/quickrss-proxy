const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sitesJsPath = path.join(__dirname, 'sites.js');
const outputPath = path.join(__dirname, 'bpc-rules.json');

// Graceful fallback if sites.js is not present
if (!fs.existsSync(sitesJsPath)) {
  console.warn('[BUILD] sites.js not found in root. Generating minimal fallback bpc-rules.json...');
  const fallback = { domains: [], archiveDomains: [], sitesMap: {} };
  fs.writeFileSync(outputPath, JSON.stringify(fallback, null, 2));
  process.exit(0);
}

try {
  const code = fs.readFileSync(sitesJsPath, 'utf-8');

  // Construct standard browser sandbox environment required by sites.js
  const sandbox = {
    window: {},
    document: {},
    location: { href: '', hostname: '' },
    navigator: { userAgent: 'Mozilla/5.0' },
    chrome: { runtime: { id: 'proxy-build' } },
    browser: { runtime: { id: 'proxy-build' } },
    console: { log: () => {}, warn: () => {}, error: () => {} }
  };
  
  const context = vm.createContext(sandbox);

  // Execute sites.js inside the isolated context
  vm.runInContext(code, context);

  // Extract site dictionaries (supports standard BPC and OAM extension formats)
  const rawSites = context.defaultSites || context.defaultSites_OAM || context.sites || {};
  const extractedDomains = new Set();
  const extractedArchiveDomains = new Set();
  const sitesMap = {};

  for (const [siteKey, config] of Object.entries(rawSites)) {
    if (!config || typeof config !== 'object') continue;

    // Resolve domain array or string
    let domainList = [];
    if (config.domain) {
      domainList = Array.isArray(config.domain) ? config.domain : [config.domain];
    } else if (siteKey.includes('.')) {
      domainList = [siteKey];
    }

    for (const rawDom of domainList) {
      const dom = String(rawDom).toLowerCase().replace(/^www\./, '').trim();
      if (!dom || dom.endsWith('.js') || dom.endsWith('.json')) continue;

      extractedDomains.add(dom);

      // Check for archive requirements in site config
      const configStr = JSON.stringify(config).toLowerCase();
      if (configStr.includes('archive') || configStr.includes('wayback')) {
        extractedArchiveDomains.add(dom);
      }

      // Populate site rules mapping for runtime server lookup
      sitesMap[dom] = {
        domain: dom,
        useragent: config.useragent || config.useragent_custom || null,
        referer: config.referer || null,
        stripImages: Boolean(config.strip_images || config.no_images),
        timeoutMs: config.timeout || null
      };
    }
  }

  const output = {
    domains: Array.from(extractedDomains),
    archiveDomains: Array.from(extractedArchiveDomains),
    sitesMap
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`[BUILD] Successfully compiled ${output.domains.length} domains and ${output.archiveDomains.length} archive rules into bpc-rules.json.`);
} catch (err) {
  console.error('[BUILD] Failed to compile sites.js:', err.message);
  process.exit(1);
}
