import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';
import { chromium } from 'playwright';
import {
    extractAlibabaProductId,
    parseAlibabaProductHtml,
    parseAlibabaSearchHtml,
} from './extractors.js';

function sanitizeRecord(obj) {
    if (Array.isArray(obj)) return obj.map((item) => sanitizeRecord(item));
    if (!obj || typeof obj !== 'object') return obj;
    const clean = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v !== null && v !== undefined && !(typeof v === 'number' && !Number.isFinite(v))) {
            clean[k] = Array.isArray(v)
                ? v.map((item) => (item && typeof item === 'object' ? sanitizeRecord(item) : item))
                : v && typeof v === 'object' && !(v instanceof Date)
                    ? sanitizeRecord(v)
                    : v;
        }
    }
    return clean;
}

function isProxyTransportError(errOrStatus) {
    const msg = String(errOrStatus?.message || errOrStatus || '');
    return errOrStatus === 597 || errOrStatus === 407 || /597|UPSTREAM407|407|Proxy responded with|tunneling socket/i.test(msg);
}

await Actor.init();

try {
    const input = (await Actor.getInput()) || {};
    const {
        productUrls = [],
        searchKeywords = [],
        verifiedSupplierOnly = false,
        tradeAssuranceOnly = false,
        maxProducts = 40,
        proxyConfiguration,
    } = input;

    log.info('Starting Alibaba B2B Wholesale & Supplier Scraper...');

    // Setup Proxy
    let proxyConfig = null;
    let proxyUrl = undefined;
    if (proxyConfiguration) {
        try {
            proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);
            if (proxyConfig) {
                proxyUrl = await proxyConfig.newUrl();
                log.info('Apify Proxy enabled');
            }
        } catch (proxyErr) {
            log.warning(`Proxy initialization failed (${proxyErr.message}); continuing with direct connection.`);
        }
    }

    const rotateOrDisableProxy = async (err) => {
        if (!isProxyTransportError(err)) return;
        if (proxyConfig) {
            try {
                proxyUrl = await proxyConfig.newUrl();
                log.warning('Rotated Apify Proxy session after upstream proxy transport error.');
                return;
            } catch {
                // Fall through to disable proxy
            }
        }
        proxyUrl = undefined;
        log.warning('Disabled broken proxy session; falling back to direct connection.');
    };

    let totalProductsScraped = 0;
    let verifiedSuppliersCount = 0;
    let tradeAssuranceCount = 0;

    // Helper: Browser instance
    let browser = null;
    const getBrowser = async () => {
        if (!browser) {
            const launchOptions = {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-blink-features=AutomationControlled',
                ],
            };
            if (proxyUrl) {
                try {
                    const u = new URL(proxyUrl);
                    launchOptions.proxy = {
                        server: `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}`,
                        ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
                        ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
                    };
                } catch {
                    launchOptions.proxy = { server: proxyUrl };
                }
            }
            browser = await chromium.launch(launchOptions);
        }
        return browser;
    };

    const effectiveProductUrls = Array.isArray(productUrls) && productUrls.length > 0
        ? productUrls
        : (!Array.isArray(searchKeywords) || searchKeywords.length === 0)
            ? ['https://www.alibaba.com/product-detail/Wholesale-Custom-Logo-Bamboo-Cutting-Board_1600123456789.html']
            : [];

    // 1. Process Direct Product URLs
    if (effectiveProductUrls.length > 0) {
        log.info(`Scraping ${effectiveProductUrls.length} direct Alibaba product URLs...`);

        for (const rawUrl of effectiveProductUrls) {
            const targetUrl = typeof rawUrl === 'string' ? rawUrl : rawUrl?.url;
            if (!targetUrl) continue;

            log.info(`Fetching Alibaba Product: ${targetUrl}`);
            let product = null;

            // Strategy A: gotScraping
            try {
                const response = await gotScraping({
                    url: targetUrl,
                    proxyUrl,
                    headers: {
                        'accept-language': 'en-US,en;q=0.9',
                        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
                    },
                    timeout: { request: 30000 },
                });

                const html = response.body;
                if (!html.includes('punish') && !html.includes('sec.alibaba.com')) {
                    product = parseAlibabaProductHtml(html, targetUrl);
                }
            } catch (err) {
                await rotateOrDisableProxy(err);
                log.debug(`gotScraping error for ${targetUrl}: ${err.message}`);
            }

            // Strategy B: Browser fallback
            if (!product || !product.title) {
                try {
                    log.info(`Using browser fallback for Alibaba product: ${targetUrl}...`);
                    const b = await getBrowser();
                    const page = await b.newPage();
                    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
                    await page.waitForTimeout(2500);

                    const html = await page.content();
                    product = parseAlibabaProductHtml(html, targetUrl);
                    await page.close();
                } catch (bErr) {
                    await rotateOrDisableProxy(bErr);
                    log.warning(`Browser fallback error for ${targetUrl}: ${bErr.message}`);
                }
            }

            if (product && product.title) {
                await Actor.pushData(sanitizeRecord(product));
                totalProductsScraped++;
                if (product.isVerified) verifiedSuppliersCount++;
                if (product.hasTradeAssurance) tradeAssuranceCount++;

                log.info(`[${totalProductsScraped}] Scraped: "${product.title.slice(0, 40)}..." | MOQ: ${product.moq} | Price: ${product.priceRange || 'N/A'}`);
            } else {
                log.warning(`Could not extract valid product from: ${targetUrl}`);
            }

            // Polite delay
            await new Promise((r) => setTimeout(r, 1500));
        }
    }

    // 2. Process Search Keywords
    if (Array.isArray(searchKeywords) && searchKeywords.length > 0) {
        log.info(`Searching Alibaba for ${searchKeywords.length} keywords...`);

        for (const keyword of searchKeywords) {
            log.info(`Searching Alibaba for: "${keyword}" (max: ${maxProducts})`);

            let searchUrl = `https://www.alibaba.com/trade/search?fsb=y&IndexArea=product_en&SearchText=${encodeURIComponent(keyword)}`;
            if (verifiedSupplierOnly) searchUrl += '&isVerified=true';
            if (tradeAssuranceOnly) searchUrl += '&tradeAssurance=true';

            try {
                let html = null;

                try {
                    const response = await gotScraping({
                        url: searchUrl,
                        proxyUrl,
                        headers: {
                            'accept-language': 'en-US,en;q=0.9',
                            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
                        },
                        timeout: { request: 30000 },
                    });
                    html = response.body;
                } catch (err) {
                    await rotateOrDisableProxy(err);
                    log.debug(`Direct search error: ${err.message}`);
                }

                if (!html || html.includes('punish') || html.includes('sec.alibaba.com')) {
                    const b = await getBrowser();
                    const page = await b.newPage();
                    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
                    await page.waitForTimeout(3000);
                    html = await page.content();
                    await page.close();
                }

                const results = parseAlibabaSearchHtml(html);
                const sliced = results.slice(0, maxProducts);

                for (const item of sliced) {
                    item.searchKeyword = keyword;
                    await Actor.pushData(sanitizeRecord(item));
                    totalProductsScraped++;
                    if (item.isVerified) verifiedSuppliersCount++;
                    if (item.hasTradeAssurance) tradeAssuranceCount++;
                }

                log.info(`Extracted ${sliced.length} search results for "${keyword}"`);

            } catch (searchErr) {
                log.error(`Error searching Alibaba for "${keyword}": ${searchErr.message}`);
            }
        }
    }

    if (browser) {
        await browser.close();
    }

    // Save final executive summary
    const summary = {
        totalProductsScraped,
        verifiedSuppliersCount,
        tradeAssuranceCount,
        status: totalProductsScraped > 0 ? 'SUCCEEDED' : 'FAILED',
        scrapedAt: new Date().toISOString(),
    };

    await Actor.setValue('OUTPUT', summary);
    if (totalProductsScraped === 0) {
        await Actor.fail('Extracted 0 products. Verify target URLs, keywords, or proxy configuration.');
    }
    log.info(`Alibaba Scraping finished successfully! Total items: ${totalProductsScraped}`);

} catch (err) {
    log.error(`Fatal execution error: ${err.message}`, { stack: err.stack });
    await Actor.setValue('OUTPUT', { status: 'FAILED', error: err.message });
    await Actor.fail(err.message);
} finally {
    await Actor.exit();
}
