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
        /597|UPSTREAM407|407|Proxy responded with|tunneling socket|ERR_PROXY|ERR_TUNNEL|ECONNRESET/i.test(msg)
    );
}

await Actor.init();

let browser = null;
const diagnostics = [];
let totalProductsScraped = 0;
let verifiedSuppliersCount = 0;
let tradeAssuranceCount = 0;

Actor.on('aborting', async () => {
    try {
        if (browser) await browser.close().catch(() => {});
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

    // Setup Proxy
    let proxyConfig = null;
    let proxyUrl = undefined;
    let proxyEnabled = false;
    if (proxyConfiguration) {
        try {
            proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);
            if (proxyConfig) {
                proxyUrl = await proxyConfig.newUrl();
                proxyEnabled = Boolean(proxyUrl);
                log.info('Apify Proxy enabled');
            }
        } catch (proxyErr) {
            log.warning(`Proxy initialization failed (${proxyErr.message}); continuing with direct connection.`);
        }
    }

    const closeBrowser = async () => {
        if (browser) {
            await browser.close().catch(() => {});
            browser = null;
        }
    };

    const rotateOrDisableProxy = async (reason) => {
        if (!proxyEnabled && !isProxyTransportError(reason)) return;
        await closeBrowser();
        if (proxyConfig && isProxyTransportError(reason)) {
            try {
                proxyUrl = await proxyConfig.newUrl();
                proxyEnabled = Boolean(proxyUrl);
                log.warning('Rotated Apify Proxy session after transport error.');
                return;
            } catch {
                // Fall through to disable proxy
            }
        }
        if (proxyUrl !== undefined) {
            proxyUrl = undefined;
            proxyEnabled = false;
            log.warning('Disabled broken proxy session; falling back to direct connection.');
        }
    };

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
                        server: `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`,
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

    const fetchHtmlWithHttp = async (url) => {
        let lastErr = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const res = await gotScraping({
                    url,
                    proxyUrl,
                    headers: {
                        'accept-language': 'en-US,en;q=0.9',
                        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
                    },
                    timeout: { request: 25000 },
                    throwHttpErrors: false,
                });
                const body = res.body || '';
                const stateInfo = detectAlibabaPageState(body, res.statusCode);
                return { html: body, statusCode: res.statusCode, ...stateInfo };
            } catch (err) {
                lastErr = err;
                if (isProxyTransportError(err) || attempt === 1) {
                    await rotateOrDisableProxy(err);
                    continue;
                }
                break;
            }
        }
        return { html: '', statusCode: 0, state: 'http_error', reason: lastErr?.message || 'HTTP request failed' };
    };

    const fetchWithPlaywright = async (url, mode = 'product') => {
        for (let attempt = 1; attempt <= 2; attempt++) {
            let page = null;
            let context = null;
            try {
                const b = await getBrowser();
                context = await b.newContext({
                    locale: 'en-US',
                    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
                });
                page = await context.newPage();
                await page.route('**/*.{mp4,webm,avi,woff,woff2}', (route) => route.abort());

                const capturedJsonPayloads = [];
                page.on('response', async (resp) => {
                    const rUrl = resp.url();
                    const ct = resp.headers()['content-type'] || '';
                    if (ct.includes('json') && /(search|offer|product|detail|icbu)/i.test(rUrl)) {
                        try {
                            const data = await resp.json();
                            if (data && typeof data === 'object') capturedJsonPayloads.push(data);
                        } catch {
                            // Ignore unparseable/streamed responses
                        }
                    }
                });

                const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
                const statusCode = response ? response.status() : 200;

                const selector = mode === 'search'
                    ? '[data-offer-id], .fy23-search-card, .searchx-offer-item, a[href*="/product-detail/"], punish-component'
                    : 'h1, .product-title, .module-pdp-title, punish-component';
                await page.waitForSelector(selector, { timeout: 10000 }).catch(() => {});

                const html = await page.content();
                const domData = await page.evaluate(() => {
                    const out = { cards: [] };
                    const anchors = Array.from(document.querySelectorAll('a[href*="/product-detail/"]'));
                    for (const a of anchors.slice(0, 80)) {
                        const href = a.href || a.getAttribute('href') || '';
                        const card = a.closest('[data-offer-id], .fy23-search-card, .searchx-offer-item, .organic-gallery-offer, .list-no-v2-outer, div') || a.parentElement;
                        const text = (a.innerText || a.getAttribute('title') || '').trim();
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

                await page.close();
                await context.close();

                const stateInfo = detectAlibabaPageState(html, statusCode);
                return { html, statusCode, capturedJsonPayloads, domData, ...stateInfo };
            } catch (err) {
                if (page) await page.close().catch(() => {});
                if (context) await context.close().catch(() => {});
                if (isProxyTransportError(err) && attempt === 1) {
                    await rotateOrDisableProxy(err);
                    continue;
                }
                return { html: '', statusCode: 0, capturedJsonPayloads: [], domData: { cards: [] }, state: 'browser_error', reason: err.message };
            }
        }
        return { html: '', statusCode: 0, capturedJsonPayloads: [], domData: { cards: [] }, state: 'browser_error', reason: 'Playwright attempts exhausted' };
    };

    const effectiveProductUrls = Array.isArray(productUrls)
        ? productUrls.filter((u) => (typeof u === 'string' ? u.trim() : u?.url))
        : [];
    const effectiveSearchKeywords =
        Array.isArray(searchKeywords) && searchKeywords.length > 0
            ? searchKeywords.filter((k) => typeof k === 'string' && k.trim())
            : effectiveProductUrls.length === 0
                ? ['bamboo cutting board']
                : [];

    // 1. Process Direct Product URLs
    if (effectiveProductUrls.length > 0) {
        log.info(`Scraping ${effectiveProductUrls.length} direct Alibaba product URLs...`);

        for (const rawUrl of effectiveProductUrls) {
            const targetUrl = (typeof rawUrl === 'string' ? rawUrl : rawUrl?.url)?.trim();
            if (!targetUrl) continue;

            log.info(`Fetching Alibaba Product: ${targetUrl}`);
            let product = null;

            const httpRes = await fetchHtmlWithHttp(targetUrl);
            if (httpRes.state === 'ok') {
                product = parseAlibabaProductHtml(httpRes.html, targetUrl);
            }

            let finalState = httpRes.state;
            let finalReason = httpRes.reason;

            // Avoid wasting browser run if page is explicitly "Product Not Available"
            if ((!product || !product.title) && httpRes.state !== 'unavailable') {
                log.info(`Using browser fallback for Alibaba product: ${targetUrl}...`);
                const pwRes = await fetchWithPlaywright(targetUrl, 'product');
                finalState = pwRes.state;
                finalReason = pwRes.reason;
                if (pwRes.state === 'ok') {
                    product = parseAlibabaProductHtml(pwRes.html, targetUrl);
                }
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
                let results = httpRes.state === 'ok' ? parseAlibabaSearchHtml(httpRes.html) : [];
                let finalState = httpRes.state;
                let finalReason = httpRes.reason;

                if (results.length === 0) {
                    log.info(`Using browser fallback for Alibaba search: "${keyword}" (HTTP state=${httpRes.state})...`);
                    const pwRes = await fetchWithPlaywright(searchUrl, 'search');
                    finalState = pwRes.state;
                    finalReason = pwRes.reason;

                    if (pwRes.state === 'ok') {
                        results = parseAlibabaSearchHtml(pwRes.html);

                        // Enrich from passively captured XHR/JSON responses if SSR HTML was hydrated dynamically
                        if (results.length === 0 && pwRes.capturedJsonPayloads.length > 0) {
                            const seenUrls = new Set();
                            for (const payload of pwRes.capturedJsonPayloads) {
                                for (const offer of collectOfferObjects(payload)) {
                                    const normalized = normalizeOfferNodeToSearchItem(offer);
                                    if (normalized && normalized.url && !seenUrls.has(normalized.url)) {
                                        seenUrls.add(normalized.url);
                                        results.push(normalized);
                                    }
                                }
                            }
                        }

                        // Live DOM fallback if embedded JSON & CSS card regexes missed dynamic classes
                        if (results.length === 0 && pwRes.domData?.cards?.length > 0) {
                            const seen = new Set();
                            for (const card of pwRes.domData.cards) {
                                if (seen.has(card.url)) continue;
                                seen.add(card.url);
                                const priceHit = card.cardText.match(/(?:\$|US\s*\$)\s*[\d,.]+(?:\s*-\s*[\d,.]+)?/);
                                const moqHit = card.cardText.match(/(\d[\d,]*)\s*(?:pieces?|pcs|sets?|units?)/i);
                                const priceStr = priceHit ? priceHit[0] : null;
                                const moqStr = moqHit ? moqHit[0] : null;
                                results.push({
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
                    }
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

    await closeBrowser();

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
        const lastDiag = diagnostics[diagnostics.length - 1];
        const hint = lastDiag?.reason ? ` Last diagnostic: ${lastDiag.state} (${lastDiag.reason}).` : '';
        await Actor.fail(`Extracted 0 products.${hint} Verify target URLs, keywords, or enable Apify Residential Proxy.`);
    }
    log.info(`Alibaba Scraping finished successfully! Total items: ${totalProductsScraped}`);
} catch (err) {
    log.error(`Fatal execution error: ${err.message}`, { stack: err.stack });
    await closeBrowser().catch(() => {});
    await Actor.setValue('OUTPUT', { status: 'FAILED', error: err.message, diagnostics });
    await Actor.fail(err.message);
} finally {
    await Actor.exit();
}
