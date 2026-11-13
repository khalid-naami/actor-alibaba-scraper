import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';
import { chromium } from 'playwright';
import {
    collectOfferObjects,
    detectAlibabaPageState,
    extractAlibabaProductId,
    normalizeOfferNodeToSearchItem,
    parseAlibabaMoq,
    parseAlibabaPrice,
    parseAlibabaProductHtml,
    parseAlibabaSearchHtml,
} from './extractors.js';

function sanitizeRecord(obj) {
    if (obj === null || obj === undefined) return undefined;
    if (typeof obj === 'number') return Number.isFinite(obj) ? obj : undefined;
    if (Array.isArray(obj)) {
        return obj.map(sanitizeRecord).filter((v) => v !== undefined);
    }
    if (typeof obj === 'object' && !(obj instanceof Date)) {
        const clean = {};
        for (const [k, v] of Object.entries(obj)) {
            const val = sanitizeRecord(v);
            if (val !== undefined) clean[k] = val;
        }
        return clean;
    }
    return obj;
}

function isProxyTransportError(errOrStatus) {
    const msg = String(errOrStatus?.message || errOrStatus || '');
    return (
        errOrStatus === 597 ||
        errOrStatus === 407 ||
        errOrStatus === 502 ||
        /597|UPSTREAM407|407|Proxy responded with|tunneling socket|ERR_PROXY|ERR_TUNNEL|ECONNRESET|ECONNREFUSED/i.test(msg)
    );
}

function parsePlaywrightProxy(proxyUrl) {
    if (!proxyUrl) return undefined;
    try {
        const u = new URL(proxyUrl);
        const proxy = {
            server: `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`,
        };
        if (u.username) proxy.username = decodeURIComponent(u.username);
        if (u.password) proxy.password = decodeURIComponent(u.password);
        return proxy;
    } catch {
        return { server: proxyUrl };
    }
}

await Actor.init();

let activeBrowser = null;
let hasFailed = false;
const diagnostics = [];
let totalProductsScraped = 0;
let verifiedSuppliersCount = 0;
let tradeAssuranceCount = 0;

Actor.on('aborting', async () => {
    try {
        if (activeBrowser) await activeBrowser.close().catch(() => {});
        await Actor.setValue('OUTPUT', {
            totalProductsScraped,
            verifiedSuppliersCount,
            tradeAssuranceCount,
            status: 'ABORTED',
            diagnostics,
            scrapedAt: new Date().toISOString(),
        });
    } catch {
        // Ignore cleanup errors on abort
    }
    await Actor.exit();
});

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

    let proxyConfig = null;
    let proxyTransportBlocked = false;
    if (proxyConfiguration) {
        try {
            proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);
            if (proxyConfig) {
                log.info('Apify Proxy enabled', {
                    groups: proxyConfig.groups || [],
                    countryCode: proxyConfig.countryCode || null,
                    isManInTheMiddle: Boolean(proxyConfig.isManInTheMiddle),
                });
            }
        } catch (proxyErr) {
            log.warning(`Proxy initialization failed (${proxyErr.message}); continuing with direct connection.`);
        }
    }

    const getFreshProxyUrl = async () => {
        if (!proxyConfig || proxyTransportBlocked) return undefined;
        try {
            return await proxyConfig.newUrl();
        } catch {
            return undefined;
        }
    };

    const fetchHtmlWithHttp = async (url) => {
        try {
            new URL(url);
        } catch {
            return { html: '', statusCode: 0, state: 'invalid_url', reason: `Invalid URL: ${url}` };
        }

        const maxAttempts = proxyConfig && !proxyTransportBlocked ? 2 : 1;
        let lastRes = { html: '', statusCode: 0, state: 'http_error', reason: 'HTTP request failed' };

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const attemptProxyUrl = await getFreshProxyUrl();
            try {
                const res = await gotScraping({
                    url,
                    proxyUrl: attemptProxyUrl,
                    headers: {
                        'accept-language': 'en-US,en;q=0.9',
                        'accept-encoding': 'gzip, deflate, br',
                        'sec-fetch-site': 'none',
                    },
                    headerGeneratorOptions: {
                        browsers: [{ name: 'chrome' }],
                        operatingSystems: ['windows', 'linux'],
                    },
                    sessionToken: {},
                    retry: { limit: 1 },
                    timeout: { request: 25000 },
                    throwHttpErrors: false,
                });

                if (isProxyTransportError(res.statusCode)) {
                    log.warning(`HTTP proxy transport status ${res.statusCode}; switching to direct connection for remaining requests.`);
                    proxyTransportBlocked = true;
                    continue;
                }

                const body = res.body || '';
                const stateInfo = detectAlibabaPageState(body, res.statusCode);
                lastRes = { html: body, statusCode: res.statusCode, ...stateInfo };
                if (stateInfo.state !== 'antibot_challenge') {
                    return lastRes;
                }
            } catch (err) {
                if (isProxyTransportError(err)) {
                    log.warning(`Proxy transport error (${err.message}); switching to direct connection.`);
                    proxyTransportBlocked = true;
                }
                lastRes = { html: '', statusCode: 0, state: 'http_error', reason: err.message };
            }
        }
        return lastRes;
    };

    const safePageContent = async (page) => {
        for (let i = 0; i < 3; i++) {
            try {
                return await page.content();
            } catch (err) {
                if (i === 2) throw err;
                await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
                await page.waitForTimeout(500);
            }
        }
        return '';
    };

    const runPlaywrightOnce = async (url, mode = 'product', attemptProxyUrl = undefined) => {
        // Inside Apify's xvfb-run container, DISPLAY is set so Chromium can run non-headless (avoiding HeadlessChrome fingerprints)
        const hasXvfbDisplay = process.platform === 'linux' && Boolean(process.env.DISPLAY);
        const launchOptions = {
            headless: !hasXvfbDisplay,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-webgl',
                '--disable-3d-apis',
                '--disable-software-rasterizer',
                '--disable-extensions',
                '--no-first-run',
                '--mute-audio',
                '--ignore-certificate-errors',
                '--ignore-certificate-errors-spki-list',
                '--disable-blink-features=AutomationControlled',
            ],
        };
        if (attemptProxyUrl) {
            launchOptions.proxy = parsePlaywrightProxy(attemptProxyUrl);
        }

        const browser = await chromium.launch(launchOptions);
        activeBrowser = browser;
        try {
            const browserVersion = browser.version() || '147.0.0.0';
            const cleanUserAgent = `Mozilla/5.0 (${process.platform === 'linux' ? 'X11; Linux x86_64' : 'Windows NT 10.0; Win64; x64'}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browserVersion} Safari/537.36`;

            const context = await browser.newContext({
                ignoreHTTPSErrors: true,
                userAgent: cleanUserAgent,
                locale: 'en-US',
                viewport: { width: 1366, height: 768 },
                extraHTTPHeaders: {
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Referer': 'https://www.alibaba.com/',
                },
            });

            await context.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            });

            const page = await context.newPage();
            await page.route('**/*', (route) => {
                const type = route.request().resourceType();
                if (['image', 'media', 'font'].includes(type)) {
                    return route.abort();
                }
                return route.continue();
            });

            const capturedJsonPayloads = [];
            page.on('response', async (resp) => {
                const rUrl = resp.url();
                const ct = resp.headers()['content-type'] || '';
                if (ct.includes('json') && /(search|offer|product|detail|icbu)/i.test(rUrl)) {
                    try {
                        const data = await resp.json();
                        if (data && typeof data === 'object') capturedJsonPayloads.push(data);
                    } catch {
                        // Ignore non-JSON or streamed bodies
                    }
                }
            });

            const navResp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
            const statusCode = navResp ? navResp.status() : 200;

            const selector = mode === 'search'
                ? '[data-offer-id], .fy23-search-card, .searchx-offer-item, a[href*="/product-detail/"], punish-component'
                : 'h1, .product-title, .module-pdp-title, punish-component';
            await page.waitForSelector(selector, { timeout: 12000 }).catch(() => {});
            await page.waitForTimeout(1000);

            const html = await safePageContent(page);
            const domData = await page.evaluate(() => {
                const out = { cards: [] };
                const anchors = Array.from(document.querySelectorAll('a[href*="/product-detail/"]'));
                for (const a of anchors.slice(0, 80)) {
                    const href = a.href || a.getAttribute('href') || '';
                    const card = a.closest('[data-offer-id], .fy23-search-card, .searchx-offer-item, .organic-gallery-offer, .list-no-v2-outer, div') || a.parentElement;
                    const text = (a.innerText || a.getAttribute('title') || a.querySelector('img')?.getAttribute('alt') || '').trim();
                    const cardText = card ? (card.innerText || '') : '';
                    const img = card ? card.querySelector('img') : null;
                    if (href && text.length > 8) {
                        out.cards.push({
                            url: href.split('?')[0],
                            title: text,
                            cardText: cardText.slice(0, 400),
                            thumbnail: img ? (img.src || img.getAttribute('data-src')) : null,
                        });
                    }
                }
                return out;
            }).catch(() => ({ cards: [] }));

            const stateInfo = detectAlibabaPageState(html, statusCode);
            return { html, statusCode, capturedJsonPayloads, domData, ...stateInfo };
        } finally {
            if (activeBrowser === browser) activeBrowser = null;
            await browser.close().catch(() => {});
        }
    };

    const fetchWithPlaywright = async (url, mode = 'product', extractCheck = null) => {
        try {
            new URL(url);
        } catch {
            return { html: '', statusCode: 0, capturedJsonPayloads: [], domData: { cards: [] }, state: 'invalid_url', reason: `Invalid URL: ${url}` };
        }

        const maxPwAttempts = proxyConfig && !proxyTransportBlocked ? 2 : 1;
        let lastRes = { html: '', statusCode: 0, capturedJsonPayloads: [], domData: { cards: [] }, state: 'browser_error', reason: 'Playwright failed' };

        for (let pwAttempt = 1; pwAttempt <= maxPwAttempts; pwAttempt++) {
            const pwProxyUrl = await getFreshProxyUrl();
            try {
                const res = await runPlaywrightOnce(url, mode, pwProxyUrl);
                lastRes = res;
                const hasItems = typeof extractCheck === 'function' ? extractCheck(res) : false;
                if (hasItems || res.state === 'unavailable') {
                    return res;
                }
                if (pwAttempt < maxPwAttempts) {
                    log.warning(`Playwright attempt ${pwAttempt}/${maxPwAttempts} yielded state=${res.state} (${res.reason}). Retrying with a fresh proxy IP...`);
                    await new Promise((r) => setTimeout(r, 1200));
                }
            } catch (pwErr) {
                if (isProxyTransportError(pwErr)) {
                    proxyTransportBlocked = true;
                }
                lastRes = { html: '', statusCode: 0, capturedJsonPayloads: [], domData: { cards: [] }, state: 'browser_error', reason: pwErr.message };
                if (pwAttempt < maxPwAttempts) {
                    log.warning(`Playwright attempt ${pwAttempt}/${maxPwAttempts} failed (${pwErr.message}). Retrying...`);
                    await new Promise((r) => setTimeout(r, 1200));
                }
            }
        }
        return lastRes;
    };

    const extractSearchResultsFromPw = (pwRes) => {
        let items = parseAlibabaSearchHtml(pwRes.html);

        if (items.length === 0 && Array.isArray(pwRes.capturedJsonPayloads) && pwRes.capturedJsonPayloads.length > 0) {
            const seenUrls = new Set();
            for (const payload of pwRes.capturedJsonPayloads) {
                for (const offer of collectOfferObjects(payload)) {
                    const normalized = normalizeOfferNodeToSearchItem(offer);
                    if (normalized && normalized.url && !seenUrls.has(normalized.url)) {
                        seenUrls.add(normalized.url);
                        items.push(normalized);
                    }
                }
            }
        }

        if (items.length === 0 && pwRes.domData?.cards?.length > 0) {
            const seen = new Set();
            for (const card of pwRes.domData.cards) {
                if (seen.has(card.url)) continue;
                seen.add(card.url);
                const priceHit = card.cardText.match(/(?:\$|US\s*\$)\s*[\d,.]+(?:\s*-\s*[\d,.]+)?/);
                const moqHit = card.cardText.match(/(\d[\d,]*)\s*(?:pieces?|pcs|sets?|units?)/i);
                const priceStr = priceHit ? priceHit[0] : null;
                const moqStr = moqHit ? moqHit[0] : null;
                items.push({
                    productId: extractAlibabaProductId(card.url),
                    title: card.title,
                    priceRange: priceStr,
                    minPrice: parseAlibabaPrice(priceStr),
                    moq: moqStr,
                    moqNumber: parseAlibabaMoq(moqStr),
                    isVerified: /verified/i.test(card.cardText),
                    hasTradeAssurance: /trade assurance/i.test(card.cardText),
                    thumbnail: card.thumbnail && card.thumbnail.startsWith('//') ? `https:${card.thumbnail}` : card.thumbnail,
                    url: card.url,
                    scrapedAt: new Date().toISOString(),
                });
            }
        }
        return items;
    };

    // Route plain keywords accidentally passed in productUrls cleanly to search
    const rawProductUrlEntries = Array.isArray(productUrls) ? productUrls : [];
    const effectiveProductUrls = [];
    const keywordSet = new Set(
        (Array.isArray(searchKeywords) ? searchKeywords : [])
            .map((k) => (typeof k === 'string' ? k.trim() : ''))
            .filter(Boolean)
    );

    for (const rawEntry of rawProductUrlEntries) {
        const rawStr = (typeof rawEntry === 'string' ? rawEntry : rawEntry?.url || '')?.trim();
        if (!rawStr) continue;
        const normalized = /^(?:www\.)?alibaba\.com\//i.test(rawStr) ? `https://${rawStr}` : rawStr;
        let parsed = null;
        try {
            parsed = new URL(normalized);
        } catch {
            parsed = null;
        }
        if (parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
            effectiveProductUrls.push(parsed.toString());
        } else {
            log.warning(`Ignoring non-URL entry in "productUrls" ("${rawStr}") and routing it to keyword search instead.`);
            keywordSet.add(rawStr);
        }
    }

    if (effectiveProductUrls.length === 0 && keywordSet.size === 0) {
        keywordSet.add('bamboo cutting board');
    }
    const effectiveSearchKeywords = [...keywordSet];

    // 1. Process Direct Product URLs
    if (effectiveProductUrls.length > 0) {
        log.info(`Scraping ${effectiveProductUrls.length} direct Alibaba product URLs...`);

        for (const targetUrl of effectiveProductUrls) {
            log.info(`Fetching Alibaba Product: ${targetUrl}`);
            let product = null;

            const httpRes = await fetchHtmlWithHttp(targetUrl);
            if (httpRes.state === 'ok') {
                product = parseAlibabaProductHtml(httpRes.html, targetUrl);
            }

            let finalState = httpRes.state;
            let finalReason = httpRes.reason;

            if ((!product || !product.title) && httpRes.state !== 'unavailable' && httpRes.state !== 'invalid_url') {
                log.info(`Using browser fallback for Alibaba product: ${targetUrl}...`);
                const pwRes = await fetchWithPlaywright(
                    targetUrl,
                    'product',
                    (res) => Boolean(parseAlibabaProductHtml(res.html, targetUrl)?.title)
                );
                product = parseAlibabaProductHtml(pwRes.html, targetUrl);
                finalState = product?.title ? 'ok' : pwRes.state;
                finalReason = product?.title ? 'OK' : pwRes.reason;
            }

            if (product && product.title) {
                await Actor.pushData(sanitizeRecord(product));
                totalProductsScraped++;
                if (product.isVerified) verifiedSuppliersCount++;
                if (product.hasTradeAssurance) tradeAssuranceCount++;
                diagnostics.push({ target: targetUrl, mode: 'product', state: 'ok', itemsExtracted: 1 });
                log.info(`[${totalProductsScraped}] Scraped: "${product.title.slice(0, 45)}..." | MOQ: ${product.moq} | Price: ${product.priceRange || 'N/A'}`);
            } else {
                diagnostics.push({ target: targetUrl, mode: 'product', state: finalState, reason: finalReason, itemsExtracted: 0 });
                log.warning(`Could not extract valid product from ${targetUrl} (state=${finalState}: ${finalReason})`);
            }

            await new Promise((r) => setTimeout(r, 1200));
        }
    }

    // 2. Process Search Keywords
    if (effectiveSearchKeywords.length > 0) {
        log.info(`Searching Alibaba for ${effectiveSearchKeywords.length} keyword(s)...`);

        for (const keyword of effectiveSearchKeywords) {
            log.info(`Searching Alibaba for: "${keyword}" (max: ${maxProducts})`);

            let searchUrl = `https://www.alibaba.com/trade/search?fsb=y&IndexArea=product_en&SearchText=${encodeURIComponent(keyword)}`;
            if (verifiedSupplierOnly) searchUrl += '&isVerified=true';
            if (tradeAssuranceOnly) searchUrl += '&tradeAssurance=true';

            try {
                const httpRes = await fetchHtmlWithHttp(searchUrl);
                let results = parseAlibabaSearchHtml(httpRes.html);
                let finalState = results.length > 0 ? 'ok' : httpRes.state;
                let finalReason = results.length > 0 ? 'OK' : httpRes.reason;

                // Try Alibaba SSR catalog page (/products/<slug>.html) when /trade/search returns an empty SPA shell
                if (results.length === 0 && !verifiedSupplierOnly && !tradeAssuranceOnly && httpRes.state !== 'antibot_challenge') {
                    const slug = keyword.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
                    if (slug) {
                        const catalogUrl = `https://www.alibaba.com/products/${slug}.html`;
                        const catalogRes = await fetchHtmlWithHttp(catalogUrl);
                        const catalogItems = parseAlibabaSearchHtml(catalogRes.html);
                        if (catalogItems.length > 0) {
                            results = catalogItems;
                            finalState = 'ok';
                            finalReason = 'OK';
                            log.info(`Extracted ${results.length} SSR search items via ${catalogUrl}`);
                        } else if (catalogRes.state !== 'ok') {
                            finalState = catalogRes.state;
                            finalReason = catalogRes.reason;
                        }
                    }
                }

                if (results.length === 0) {
                    log.info(`Using browser fallback for Alibaba search: "${keyword}" (HTTP state=${finalState}, len=${httpRes.html?.length || 0})...`);
                    const pwRes = await fetchWithPlaywright(
                        searchUrl,
                        'search',
                        (res) => extractSearchResultsFromPw(res).length > 0
                    );
                    results = extractSearchResultsFromPw(pwRes);
                    finalState = results.length > 0 ? 'ok' : pwRes.state;
                    finalReason = results.length > 0 ? 'OK' : pwRes.reason;
                }

                const sliced = results.slice(0, maxProducts);
                for (const item of sliced) {
                    item.searchKeyword = keyword;
                    await Actor.pushData(sanitizeRecord(item));
                    totalProductsScraped++;
                    if (item.isVerified) verifiedSuppliersCount++;
                    if (item.hasTradeAssurance) tradeAssuranceCount++;
                }

                diagnostics.push({
                    target: keyword,
                    mode: 'search',
                    state: sliced.length > 0 ? 'ok' : finalState,
                    reason: sliced.length > 0 ? 'OK' : finalReason,
                    itemsExtracted: sliced.length,
                });

                if (sliced.length > 0) {
                    log.info(`Extracted ${sliced.length} search results for "${keyword}"`);
                } else {
                    log.warning(`Extracted 0 search results for "${keyword}" (state=${finalState}: ${finalReason})`);
                }
            } catch (searchErr) {
                diagnostics.push({ target: keyword, mode: 'search', state: 'error', reason: searchErr.message, itemsExtracted: 0 });
                log.error(`Error searching Alibaba for "${keyword}": ${searchErr.message}`);
            }
        }
    }

    const summary = {
        totalProductsScraped,
        verifiedSuppliersCount,
        tradeAssuranceCount,
        status: totalProductsScraped > 0 ? 'SUCCEEDED' : 'FAILED',
        diagnostics,
        scrapedAt: new Date().toISOString(),
    };

    await Actor.setValue('OUTPUT', summary);
    if (totalProductsScraped === 0) {
        hasFailed = true;
        const lastDiag = diagnostics[diagnostics.length - 1];
        const hint = lastDiag?.reason ? ` Last diagnostic: ${lastDiag.state} (${lastDiag.reason}).` : '';
        await Actor.fail(`Extracted 0 products.${hint} Verify target URLs, keywords, or enable Apify Residential Proxy.`);
    }
    log.info(`Alibaba Scraping finished successfully! Total items: ${totalProductsScraped}`);
} catch (err) {
    hasFailed = true;
    log.error(`Fatal execution error: ${err.message}`, { stack: err.stack });
    if (activeBrowser) await activeBrowser.close().catch(() => {});
    await Actor.setValue('OUTPUT', { status: 'FAILED', error: err.message, diagnostics }).catch(() => {});
    await Actor.fail(err.message);
} finally {
    if (!hasFailed) {
        await Actor.exit();
    }
}
