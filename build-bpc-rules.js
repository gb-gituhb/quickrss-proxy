// build-bpc-rules.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sitesJsPath = path.join(__dirname, 'sites.js');
const outputPath = path.join(__dirname, 'bpc-rules.json');

if (!fs.existsSync(sitesJsPath)) {
  console.warn('[BUILD] sites.js not found in root. Generating minimal empty bpc-rules.json...');
  fs.writeFileSync(outputPath, JSON.stringify({ domains: [], archiveDomains: [], sitesMap: {} }, null, 2));
  process.exit(0);
}

try {
  let code = fs.readFileSync(sitesJsPath, 'utf-8');

  // Strip CommonJS/ESM export wrappers
  code = code.replace(/export\s+default\s+/, 'var defaultSites = ');
  code = code.replace(/module\.exports\s*=\s*/, 'var defaultSites = ');

  // Browser environment stubs with circular global references
  const sandbox = {
    document: {},
    location: { href: '', hostname: '' },
    navigator: { userAgent: 'Mozilla/5.0' },
    chrome: { runtime: { id: 'proxy-build' } },
    browser: { runtime: { id: 'proxy-build' } },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetch: () => Promise.resolve({}),
    XMLHttpRequest: class FakeXHR {},
    addEventListener: () => {},
    removeEventListener: () => {},
    get window() { return this; },
    get self() { return this; },
    get globalThis() { return this; }
  };

  const context = vm.createContext(sandbox);

  const wrappedCode = `
    ${code};
    ({
      defaultSites: typeof defaultSites !== 'undefined' ? defaultSites : undefined,
      defaultSites_OAM: typeof defaultSites_OAM !== 'undefined' ? defaultSites_OAM : undefined,
      sites: typeof sites !== 'undefined' ? sites : undefined
    })
  `;

  const result = vm.runInContext(wrappedCode, context);
  const rawSites = result.defaultSites || result.defaultSites_OAM || result.sites || {};

  const extractedDomains = new Set();
  const extractedArchiveDomains = new Set();
  const sitesMap = {};

  for (const [siteKey, config] of Object.entries(rawSites)) {
    if (!config) continue;

    let domainList = [];
    let isArchive = siteKey.toLowerCase().includes('archive') || siteKey.toLowerCase().includes('wayback') || siteKey.toLowerCase().includes('archive.is');
    let useragent = null;
    let referer = null;
    let stripImages = false;
    let timeoutMs = null;

    // Support string key-value mappings (e.g., "Site Title": "domain.com")
    if (typeof config === 'string') {
      const domStr = config.trim();
      if (!domStr.startsWith('###')) {
        domainList = [domStr];
        if (domStr.toLowerCase().includes('archive') || domStr.toLowerCase().includes('wayback')) {
          isArchive = true;
        }
      }
    } 
    // Support object key-value mappings (e.g., "Site Title": { domain: "domain.com", ... })
    else if (typeof config === 'object') {
      if (config.domain) {
        domainList = Array.isArray(config.domain) ? config.domain : [config.domain];
      } else if (/^[a-z0-9-]+\.[a-z]{2,}$/i.test(siteKey)) {
        domainList = [siteKey];
      }

      const configStr = JSON.stringify(config).toLowerCase();
      if (configStr.includes('archive') || configStr.includes('wayback')) {
        isArchive = true;
      }

      useragent = config.useragent || config.useragent_custom || null;
      referer = config.referer || null;
      stripImages = Boolean(config.strip_images || config.no_images);
      timeoutMs = config.timeout || null;
    }

    for (const rawDom of domainList) {
      const dom = String(rawDom).toLowerCase().replace(/^www\./, '').trim();
      if (!dom || dom.endsWith('.js') || dom.endsWith('.json') || dom.startsWith('###')) continue;

      extractedDomains.add(dom);
      if (isArchive) {
        extractedArchiveDomains.add(dom);
      }

      sitesMap[dom] = {
        domain: dom,
        useragent,
        referer,
        stripImages,
        timeoutMs
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
