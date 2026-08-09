const fs = require('fs');
const path = require('path');

// Primary and mirror URLs for upstream BPC site definitions
const BPC_SOURCES = [
    'https://raw.githubusercontent.com/bpc-clone/bpc_updates/main/sites.js',
    'https://gitlab.com/bypassedws/bypass-paywalls-clean-filters/-/raw/main/sites.js',
    'https://raw.githubusercontent.com/bpc-clone/bpc-rules/main/sites.js'
];

async function buildBpcRules() {
    console.log('Fetching upstream BPC site definitions...');
    
    let rawText = '';
    
    for (const sourceUrl of BPC_SOURCES) {
        try {
            const res = await fetch(sourceUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'Accept': 'text/plain, */*'
                },
                signal: AbortSignal.timeout(5000)
            });
            if (res.ok) {
                rawText = await res.text();
                console.log(`Successfully fetched BPC definitions from: ${sourceUrl}`);
                break;
            }
        } catch (_) {}
    }

    if (!rawText) {
        console.warn('Failed to fetch remote BPC rules from all mirrors, using fallback dataset...');
    }

    const compiledRules = {};

    if (rawText) {
        const domainMatches = rawText.matchAll(/["']([^"']+\.[a-z]{2,})["']\s*:\s*\{([^}]+)\}/gi);

        for (const match of domainMatches) {
            const domain = match[1].toLowerCase().replace(/^www\./, '');
            const body = match[2];

            let strategy = 'default';

            if (/useragent\s*:\s*["']googlebot["']/i.test(body) || /googlebot/i.test(body)) {
                strategy = 'googlebot';
            } else if (/useragent\s*:\s*["']bingbot["']/i.test(body)) {
                strategy = 'bingbot';
            } else if (/useragent\s*:\s*["']facebook["']/i.test(body) || /referer\s*:\s*["']facebook["']/i.test(body)) {
                strategy = 'facebook';
            } else if (/useragent\s*:\s*["']twitter["']/i.test(body) || /referer\s*:\s*["']twitter["']/i.test(body)) {
                strategy = 'twitter';
            } else if (/allow_cookies\s*:\s*0/i.test(body) || /block_cookies/i.test(body)) {
                strategy = 'strip_cookies';
            } else if (/redirect/i.test(body) || /archive/i.test(body)) {
                strategy = 'archive_direct';
            }

            compiledRules[domain] = { strategy };
        }
    }

    const baseOverrides = {
        'nytimes.com': { strategy: 'googlebot' },
        'bloomberg.com': { strategy: 'googlebot' },
        'telegraph.co.uk': { strategy: 'googlebot' },
        'hbr.org': { strategy: 'googlebot' },
        'wsj.com': { strategy: 'archive_direct' },
        'ft.com': { strategy: 'archive_direct' },
        'economist.com': { strategy: 'archive_direct' },
        'medium.com': { strategy: 'twitter' },
        'washingtonpost.com': { strategy: 'strip_cookies' },
        'theguardian.com': { strategy: 'amp_force' },
        'bbc.com': { strategy: 'amp_force' },
        'bbc.co.uk': { strategy: 'amp_force' }
    };

    const finalDataset = { ...compiledRules, ...baseOverrides };
    const outputPath = path.join(__dirname, 'bpc_sites.json');

    fs.writeFileSync(outputPath, JSON.stringify(finalDataset, null, 2), 'utf8');
    console.log(`Successfully compiled ${Object.keys(finalDataset).length} BPC domain rules to bpc_sites.json`);
}

buildBpcRules();
