/**
 * Alibaba B2B Product & Supplier Extraction Handlers
 */

/**
 * Extract Alibaba product ID from URL
 */
export function extractAlibabaProductId(url) {
    if (!url || typeof url !== 'string') return null;
    const match = url.match(/_(\d{8,})\.html/) || url.match(/productId=(\d{8,})/) || url.match(/\/(\d{8,})\.html/);
    return match ? match[1] : null;
}

/**
 * Clean numeric price from string
 */
export function parseAlibabaPrice(raw) {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    if (!raw || typeof raw !== 'string') return null;
    const cleaned = raw.replace(/,/g, '').replace(/[^\d.]/g, '');
    const num = parseFloat(cleaned);
    return Number.isFinite(num) ? num : null;
}

/**
 * Parse numeric MOQ count (e.g. "1,000 Pieces" -> 1000)
 */
export function parseAlibabaMoq(raw) {
    if (typeof raw === 'number') return Number.isFinite(raw) ? Math.trunc(raw) : null;
    if (!raw || typeof raw !== 'string') return null;
    const match = raw.replace(/,/g, '').match(/(\d+)/);
    return match ? parseInt(match[1], 10) : null;
}

/**
 * Detect whether an Alibaba HTTP/HTML response is an anti-bot challenge,
 * an unavailable product ("Product Not Available"), or an HTTP error.
 */
export function detectAlibabaPageState(html, statusCode = 200) {
    if (statusCode >= 400) {
        return {
            state: statusCode === 404 ? 'unavailable' : statusCode === 403 || statusCode === 429 ? 'antibot_challenge' : 'http_error',
            reason: `HTTP ${statusCode}`,
        };
    }
    if (!html || typeof html !== 'string' || html.trim().length < 20) {
        return { state: 'empty_body', reason: 'Empty or near-empty HTML response' };
    }
    const lower = html.toLowerCase();
    if (
        lower.includes('<punish-component') ||
        lower.includes('sufei-punish') ||
        lower.includes('baxia-punish') ||
        lower.includes('sec.alibaba.com') ||
        lower.includes('rgv587_flag') ||
        lower.includes('captcha-title')
    ) {
        return {
            state: 'antibot_challenge',
            reason: 'Alibaba anti-bot/CAPTCHA gate detected (punish/baxia); Residential Proxy required',
        };
    }
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const pageTitle = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';
    if (
        /product not available|page not found|sorry, this item is no longer available/i.test(pageTitle) ||
        (/product not available/i.test(html) && !html.includes('product-title') && !html.includes('module-pdp-title'))
    ) {
        return {
            state: 'unavailable',
            reason: pageTitle || 'Product Not Available',
        };
    }
    if (html.trim().length < 100) {
        return { state: 'empty_body', reason: 'Empty or near-empty HTML response' };
    }
    return { state: 'ok', reason: pageTitle || 'OK' };
}

/**
 * Extract a balanced JSON object/array starting immediately after a regex prefix match.
 */
export function extractBalancedJson(text, prefixRegex) {
    if (!text || typeof text !== 'string') return null;
    const match = prefixRegex.exec(text);
    if (!match) return null;

    let startIdx = match.index + match[0].length;
    while (startIdx < text.length && /\s/.test(text[startIdx])) startIdx++;
    const openChar = text[startIdx];
    const closeChar = openChar === '{' ? '}' : openChar === '[' ? ']' : null;
    if (!closeChar) return null;

    let depth = 0;
    let inString = false;
    let quoteChar = '';
    let escaped = false;

    for (let i = startIdx; i < text.length; i++) {
        const ch = text[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === '\\') {
            if (inString) escaped = true;
            continue;
        }
        if (inString) {
            if (ch === quoteChar) inString = false;
            continue;
        }
        if (ch === '"' || ch === "'") {
            inString = true;
            quoteChar = ch;
            continue;
        }
        if (ch === openChar) depth++;
        else if (ch === closeChar) {
            depth--;
            if (depth === 0) {
                const candidate = text.slice(startIdx, i + 1);
                try {
                    return JSON.parse(candidate);
                } catch {
                    return null;
                }
            }
        }
    }
    return null;
}

/**
 * Extract Schema.org JSON-LD blocks from HTML.
 */
export function parseJsonLdBlocks(html) {
    const blocks = [];
    if (!html) return blocks;
    const regex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = regex.exec(html)) !== null) {
        try {
            const parsed = JSON.parse(match[1].trim());
            if (Array.isArray(parsed)) blocks.push(...parsed);
            else if (parsed && typeof parsed === 'object') blocks.push(parsed);
        } catch {
            // Skip malformed JSON-LD block
        }
    }
    return blocks;
}

function normalizeUrl(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('//')) return `https:${trimmed}`;
    return trimmed;
}

function decodeHtmlEntities(str) {
    if (!str || typeof str !== 'string') return str;
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Recursively find an offer array (search result items) inside embedded page JSON.
 */
export function collectOfferObjects(node, out = [], seen = new WeakSet(), depth = 0) {
    if (!node || typeof node !== 'object' || depth > 12 || seen.has(node)) return out;
    seen.add(node);

    if (Array.isArray(node)) {
        for (const item of node) {
            if (item && typeof item === 'object' && !Array.isArray(item)) {
                const title = item.title || item.subject || item.productTitle || item.pureTitle;
                const url = item.productUrl || item.detailUrl || item.url || item.actionUrl;
                const offerId = item.offerId || item.productId || item.id;
                if (typeof title === 'string' && title.trim().length > 3 && (typeof url === 'string' || offerId)) {
                    out.push(item);
                    continue;
                }
            }
            collectOfferObjects(item, out, seen, depth + 1);
        }
        return out;
    }

    for (const val of Object.values(node)) {
        collectOfferObjects(val, out, seen, depth + 1);
    }
    return out;
}

export function normalizeOfferNodeToSearchItem(node) {
    const title = decodeHtmlEntities(String(node.title || node.subject || node.productTitle || node.pureTitle || '').replace(/<[^>]+>/g, '').trim());
    if (!title) return null;

    const rawUrl = node.productUrl || node.detailUrl || node.url || node.actionUrl || '';
    const offerId = String(node.offerId || node.productId || node.id || extractAlibabaProductId(rawUrl) || '');
    let cleanUrl = normalizeUrl(rawUrl);
    if (!cleanUrl && offerId) {
        cleanUrl = `https://www.alibaba.com/product-detail/product_${offerId}.html`;
    } else if (cleanUrl) {
        cleanUrl = cleanUrl.split('?')[0];
    }

    const priceObj = node.price && typeof node.price === 'object' ? node.price : {};
    const priceStr = typeof node.price === 'string'
        ? node.price
        : node.priceText || node.priceRange || priceObj.priceText ||
          (priceObj.minPrice != null && priceObj.maxPrice != null
              ? `$${priceObj.minPrice} - $${priceObj.maxPrice}`
              : priceObj.minPrice != null
                  ? `$${priceObj.minPrice}`
                  : null);

    const minPrice = parseAlibabaPrice(priceObj.minPrice ?? node.minPrice ?? priceStr);
    const maxPrice = parseAlibabaPrice(priceObj.maxPrice ?? node.maxPrice ?? priceStr);

    const moqObj = node.moq && typeof node.moq === 'object' ? node.moq : {};
    const moqStr = typeof node.moq === 'string'
        ? node.moq
        : node.moqText || node.minOrderQuantity ||
          (moqObj.minOrderQuantity ? `${moqObj.minOrderQuantity} ${moqObj.unit || 'Pieces'}`.trim() : null);

    const supplierObj = node.supplier || node.company || node.seller || {};
    const supplierName = supplierObj.name || supplierObj.companyName || node.supplierName || node.companyName || null;
    const isVerified = Boolean(node.isVerified || node.verifiedSupplier || supplierObj.isVerified || supplierObj.verified);
    const hasTradeAssurance = Boolean(node.hasTradeAssurance || node.tradeAssurance || supplierObj.tradeAssurance);

    const rawThumb = node.imageUrl || node.mainImage || node.thumbnail || (Array.isArray(node.images) ? node.images[0] : null) || node.image?.src;
    const thumbnail = normalizeUrl(typeof rawThumb === 'string' ? rawThumb : null);

    return {
        productId: offerId || null,
        title,
        priceRange: priceStr || null,
        minPrice,
        maxPrice: maxPrice ?? minPrice,
        currency: priceObj.currency || node.currency || 'USD',
        moq: moqStr || null,
        moqNumber: parseAlibabaMoq(moqStr),
        supplierName,
        isVerified,
        hasTradeAssurance,
        thumbnail,
        url: cleanUrl,
        scrapedAt: new Date().toISOString(),
    };
}

/**
 * Extract product details from Alibaba Product Detail HTML (detailData + JSON-LD + DOM Regex)
 */
export function parseAlibabaProductHtml(html, url = '') {
    if (!html || typeof html !== 'string') return null;

    const stateCheck = detectAlibabaPageState(html, 200);
    if (stateCheck.state === 'antibot_challenge' || stateCheck.state === 'unavailable') {
        return null;
    }

    const productId = extractAlibabaProductId(url);
    let title = null;
    const bulkPricing = [];
    let priceRange = null;
    let minPrice = null;
    let maxPrice = null;
    let currency = 'USD';
    let moq = null;
    let moqNumber = null;
    let supplierName = null;
    let supplierYears = null;
    let supplierCountry = 'CN';
    let isVerified = false;
    let hasTradeAssurance = false;
    let reviewScore = null;
    let reviewsCount = 0;
    let leadTime = null;
    const customization = [];
    const specifications = {};
    const images = [];

    // Layer 1: window.detailData / window.globalData / window.__INITIAL_DATA__
    const detailData =
        extractBalancedJson(html, /window\.detailData\s*=\s*/i) ||
        extractBalancedJson(html, /window\.globalData\s*=\s*/i) ||
        extractBalancedJson(html, /window\.__INITIAL_DATA__\s*=\s*/i);

    if (detailData && typeof detailData === 'object') {
        const g = detailData.globalData || detailData;
        const prod = g.product || g.productInfo || {};
        const priceMod = g.priceModule || prod.priceModule || g.tradeModel || {};
        const seller = g.seller || g.supplierModule || g.companyInfo || {};
        const skuMod = g.skuModule || {};

        if (!title && (prod.subject || prod.title || g.subject)) {
            title = decodeHtmlEntities(String(prod.subject || prod.title || g.subject));
        }

        const rawLadder = priceMod.priceList || priceMod.volumePrices || prod.ladderPrices || [];
        if (Array.isArray(rawLadder)) {
            for (const tier of rawLadder) {
                const tierPrice = parseAlibabaPrice(tier?.price ?? tier?.unitPrice ?? tier?.priceValue);
                if (tierPrice !== null) {
                    const qtyLabel = tier?.quantityRange || (tier?.beginAmount != null ? `${tier.beginAmount}+` : tier?.startQuantity != null ? `${tier.startQuantity}+` : 'Tier');
                    bulkPricing.push({ quantity: String(qtyLabel), price: tierPrice });
                }
            }
        }
        if (priceMod.minPrice != null) minPrice = parseAlibabaPrice(priceMod.minPrice);
        if (priceMod.maxPrice != null) maxPrice = parseAlibabaPrice(priceMod.maxPrice);
        if (priceMod.currency || priceMod.currencyCode) currency = String(priceMod.currency || priceMod.currencyCode);
        if (prod.moq || priceMod.minOrderQuantity || priceMod.moq) {
            const rawMoq = prod.moq || priceMod.minOrderQuantity || priceMod.moq;
            moq = typeof rawMoq === 'object' ? `${rawMoq.minOrderQuantity || rawMoq.value || ''} ${rawMoq.unit || ''}`.trim() : String(rawMoq);
            moqNumber = parseAlibabaMoq(moq);
        }

        if (seller.companyName || seller.supplierName) {
            supplierName = decodeHtmlEntities(String(seller.companyName || seller.supplierName));
        }
        if (seller.years || seller.alibabaYears) {
            supplierYears = `${seller.years || seller.alibabaYears} yrs`;
        }
        if (seller.country || seller.countryCode) {
            supplierCountry = String(seller.country || seller.countryCode);
        }
        if (seller.isVerified || seller.verified || seller.isGold) isVerified = true;
        if (seller.tradeAssurance || g.tradeAssurance) hasTradeAssurance = true;

        const mediaList = prod.imageList || prod.mediaItems || skuMod.productImageList || [];
        if (Array.isArray(mediaList)) {
            for (const m of mediaList) {
                const u = normalizeUrl(typeof m === 'string' ? m : m?.url || m?.src || m?.imageUrl);
                if (u) images.push(u.replace(/_\d+x\d+.*\.jpg$/, ''));
            }
        }
        if (Array.isArray(prod.productBasicProperties)) {
            for (const prop of prod.productBasicProperties) {
                if (prop?.attrName && prop?.attrValue) {
                    specifications[decodeHtmlEntities(String(prop.attrName))] = decodeHtmlEntities(String(prop.attrValue));
                }
            }
        }
    }

    // Layer 2: Schema.org application/ld+json
    const ldBlocks = parseJsonLdBlocks(html);
    const productLd = ldBlocks.find((b) => String(b['@type'] || '').toLowerCase() === 'product');
    if (productLd) {
        if (!title && typeof productLd.name === 'string') {
            title = decodeHtmlEntities(productLd.name);
        }
        const offers = Array.isArray(productLd.offers) ? productLd.offers[0] : productLd.offers;
        if (offers && typeof offers === 'object') {
            if (offers.priceCurrency) currency = String(offers.priceCurrency);
            const low = parseAlibabaPrice(offers.lowPrice ?? offers.price);
            const high = parseAlibabaPrice(offers.highPrice ?? offers.price);
            if (minPrice === null && low !== null) minPrice = low;
            if (maxPrice === null && high !== null) maxPrice = high;
        }
        if (productLd.aggregateRating && typeof productLd.aggregateRating === 'object') {
            const ratingVal = parseFloat(productLd.aggregateRating.ratingValue);
            const countVal = parseInt(String(productLd.aggregateRating.reviewCount || productLd.aggregateRating.ratingCount || '0').replace(/,/g, ''), 10);
            if (Number.isFinite(ratingVal)) reviewScore = ratingVal;
            if (Number.isFinite(countVal) && countVal > 0) reviewsCount = countVal;
        }
        const ldImgs = Array.isArray(productLd.image) ? productLd.image : productLd.image ? [productLd.image] : [];
        for (const img of ldImgs) {
            const u = normalizeUrl(typeof img === 'string' ? img : img?.url);
            if (u) images.push(u);
        }
        if (!supplierName && productLd.brand?.name) {
            supplierName = decodeHtmlEntities(String(productLd.brand.name));
        }
    }

    // Layer 3: HTML & CSS fallback regexes
    if (!title) {
        const titleMatch =
            html.match(/class="[^"]*(?:product-title|module-pdp-title|module_title)[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) ||
            html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
        if (titleMatch) {
            const candidate = decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, ''));
            if (candidate && !/product not available|alibaba\.com/i.test(candidate)) {
                title = candidate;
            }
        }
    }

    if (bulkPricing.length === 0) {
        const ladderMatches = [...html.matchAll(/class="[^"]*(?:ladder-price-item|price-item)[^"]*"[\s\S]*?(?=(?:class="[^"]*(?:ladder-price-item|price-item)"|$))/gi)];
        for (const lm of ladderMatches) {
            const itemHtml = lm[0];
            const qtyMatch = itemHtml.match(/class="[^"]*quantity[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
            const pMatch = itemHtml.match(/class="[^"]*price[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
            if (pMatch) {
                const pVal = parseAlibabaPrice(pMatch[1]);
                const qStr = qtyMatch ? decodeHtmlEntities(qtyMatch[1].replace(/<[^>]+>/g, '')) : '';
                if (pVal !== null) {
                    bulkPricing.push({ quantity: qStr || 'Default', price: pVal });
                }
            }
        }
    }

    const rangeMatch = html.match(/class="[^"]*(?:price-range|module-price|module_price|promotion-price)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span)>/i) ||
                       html.match(/"price":"([^"]+)"/);
    if (rangeMatch) {
        const extractedRange = decodeHtmlEntities(rangeMatch[1].replace(/<[^>]+>/g, ''));
        if (extractedRange) {
            priceRange = extractedRange;
            const prices = [...extractedRange.replace(/,/g, '').matchAll(/(\d+\.\d+|\d+)/g)].map((m) => parseFloat(m[1])).filter(Number.isFinite);
            if (prices.length > 0 && minPrice === null) {
                minPrice = Math.min(...prices);
                maxPrice = Math.max(...prices);
            }
        }
    }

    if (bulkPricing.length > 0 && minPrice === null) {
        const pList = bulkPricing.map((b) => b.price);
        minPrice = Math.min(...pList);
        maxPrice = Math.max(...pList);
    }

    if (html.includes('€') || html.includes('EUR')) currency = 'EUR';
    else if (html.includes('£') || html.includes('GBP')) currency = 'GBP';

    if (!moq) {
        const moqMatch = html.match(/(?:Min\. order|Minimum order quantity|MOQ):?\s*([^<"\n]+)/i) ||
                         html.match(/class="[^"]*moq-number[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
        if (moqMatch) {
            moq = decodeHtmlEntities(moqMatch[1].replace(/<[^>]+>/g, ''));
            moqNumber = parseAlibabaMoq(moq) || 1;
        } else {
            moq = '1 Piece';
            moqNumber = 1;
        }
    } else if (moqNumber === null) {
        moqNumber = parseAlibabaMoq(moq) || 1;
    }

    if (!supplierName) {
        const supplierMatch = html.match(/class="[^"]*company-name[^"]*"[^>]*>([\s\S]*?)<\/(?:a|span|div)>/i) ||
                              html.match(/href="[^"]*company_profile[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
        if (supplierMatch) {
            supplierName = decodeHtmlEntities(supplierMatch[1].replace(/<[^>]+>/g, ''));
        }
    }

    if (!supplierYears) {
        const yearMatch = html.match(/(\d+)\s*(?:YRS|yrs|Years)/i);
        if (yearMatch) supplierYears = `${yearMatch[1]} yrs`;
    }

    if (!isVerified) {
        isVerified = html.includes('verified-supplier') || html.includes('Verified Supplier') || html.includes('icon-verified');
    }
    if (!hasTradeAssurance) {
        hasTradeAssurance = html.includes('trade-assurance') || html.includes('Trade Assurance') || html.includes('icon-ta');
    }

    if (reviewScore === null) {
        const scoreMatch = html.match(/class="[^"]*(?:star-score|rating-score|score-text)[^"]*"[^>]*>([0-5]\.[0-9]|[0-5])<\/span>/i) ||
                           html.match(/"score":([0-5]\.[0-9]|[0-5])/);
        if (scoreMatch) reviewScore = parseFloat(scoreMatch[1]);
    }

    if (reviewsCount === 0) {
        const countMatch = html.match(/(\d[\d,]*)\s*(?:Reviews|Ratings|reviews)/i);
        if (countMatch) reviewsCount = parseInt(countMatch[1].replace(/,/g, ''), 10) || 0;
    }

    const leadMatch = html.match(/(?:Lead time|Lead Time):?\s*([^<"\n]+)/i);
    if (leadMatch) leadTime = decodeHtmlEntities(leadMatch[1].replace(/<[^>]+>/g, ''));

    if (html.toLowerCase().includes('customized logo')) customization.push('Customized logo');
    if (html.toLowerCase().includes('customized packaging')) customization.push('Customized packaging');
    if (html.toLowerCase().includes('graphic customization')) customization.push('Graphic customization');

    const imgMatches = [...html.matchAll(/class="[^"]*(?:main-img|image-item|thumb)[^"]*"[^>]*src="([^"]+)"/gi)];
    for (const m of imgMatches) {
        const u = normalizeUrl(m[1]);
        if (u) images.push(u.replace(/_\d+x\d+.*\.jpg$/, ''));
    }

    const uniqueImages = [...new Set(images)];
    const thumbnail = uniqueImages[0] || null;

    if (!title) return null;

    return {
        productId,
        title,
        priceRange: priceRange || (minPrice !== null ? (maxPrice && maxPrice !== minPrice ? `$${minPrice} - $${maxPrice}` : `$${minPrice}`) : null),
        minPrice,
        maxPrice: maxPrice ?? minPrice,
        currency,
        moq,
        moqNumber,
        bulkPricing: bulkPricing.length > 0 ? bulkPricing : null,
        supplierName,
        supplierYears,
        supplierCountry,
        isVerified,
        hasTradeAssurance,
        reviewScore,
        reviewsCount,
        leadTime,
        customization: customization.length > 0 ? customization : null,
        specifications: Object.keys(specifications).length > 0 ? specifications : null,
        thumbnail,
        images: uniqueImages,
        url,
        scrapedAt: new Date().toISOString(),
    };
}

/**
 * Extract items from Alibaba search results HTML or embedded search payloads
 */
export function parseAlibabaSearchHtml(html) {
    const results = [];
    if (!html || typeof html !== 'string') return results;

    const stateCheck = detectAlibabaPageState(html, 200);
    if (stateCheck.state === 'antibot_challenge') return results;

    const seenKeys = new Set();
    const pushUnique = (item) => {
        if (!item || !item.title) return;
        const dedupeKey = item.productId || item.url || item.title;
        if (seenKeys.has(dedupeKey)) return;
        seenKeys.add(dedupeKey);
        results.push(item);
    };

    // Layer 1: Embedded JSON blobs (__page__data, _PAGE_DATA_, __INITIAL_DATA__, __SEARCH_PAGE_DATA__)
    const embeddedPayloads = [
        extractBalancedJson(html, /window\.__page__data\s*=\s*/i),
        extractBalancedJson(html, /window\._PAGE_DATA_\s*=\s*/i),
        extractBalancedJson(html, /window\.__INITIAL_DATA__\s*=\s*/i),
        extractBalancedJson(html, /window\.__SEARCH_PAGE_DATA__\s*=\s*/i),
        extractBalancedJson(html, /window\.__SEARCHX_SSE_PREFETCH__\s*=\s*/i),
        extractBalancedJson(html, /"offerList"\s*:\s*/i),
    ].filter(Boolean);

    for (const payload of embeddedPayloads) {
        const offers = collectOfferObjects(payload);
        for (const node of offers) {
            pushUnique(normalizeOfferNodeToSearchItem(node));
        }
    }

    // Layer 1b: Schema.org ItemList / Product JSON-LD blocks
    const ldBlocks = parseJsonLdBlocks(html);
    for (const block of ldBlocks) {
        const elems = Array.isArray(block?.itemListElement) ? block.itemListElement : [];
        for (const el of elems) {
            const itemNode = el?.item && typeof el.item === 'object' ? el.item : el;
            const rawUrl = itemNode?.url || el?.url;
            const cleanUrl = normalizeUrl(rawUrl)?.split('?')[0];
            const title = itemNode?.name ? decodeHtmlEntities(String(itemNode.name)) : null;
            if (!title || !cleanUrl || !cleanUrl.includes('/product-detail/')) continue;
            const offerObj = Array.isArray(itemNode?.offers) ? itemNode.offers[0] : itemNode?.offers;
            const lowPrice = parseAlibabaPrice(offerObj?.lowPrice ?? offerObj?.price);
            pushUnique({
                productId: extractAlibabaProductId(cleanUrl),
                title,
                priceRange: lowPrice !== null ? `$${lowPrice}` : null,
                minPrice: lowPrice,
                moq: null,
                moqNumber: null,
                isVerified: false,
                hasTradeAssurance: false,
                thumbnail: normalizeUrl(typeof itemNode?.image === 'string' ? itemNode.image : itemNode?.image?.[0]),
                url: cleanUrl,
                scrapedAt: new Date().toISOString(),
            });
        }
    }

    // Layer 2: Structured product cards in SSR / hydrated HTML
    const cards = [
        ...html.matchAll(/class="[^"]*(?:fy23-search-card|list-no-v2-outer|organic-gallery-offer|searchx-offer-item|m-gallery-product-item-v2|gallery-offer-card|card-info)[^"]*"[\s\S]*?(?=(?:class="[^"]*(?:fy23-search-card|list-no-v2-outer|organic-gallery-offer|searchx-offer-item|m-gallery-product-item-v2|gallery-offer-card|card-info)"|$))/gi),
    ];

    for (const c of cards) {
        const cardHtml = c[0];
        const linkMatch = cardHtml.match(/href="(\/\/[^"]*alibaba\.com\/product-detail\/[^"]+)"/i) ||
                          cardHtml.match(/href="([^"]*\/product-detail\/[^"]+)"/i);
        if (!linkMatch) continue;

        const cleanUrl = normalizeUrl(linkMatch[1])?.split('?')[0];
        const productId = extractAlibabaProductId(cleanUrl);

        const titleMatch = cardHtml.match(/class="[^"]*(?:search-card-e-title|elements-title-normal__outter|searchx-product-title)[^"]*"[^>]*>([\s\S]*?)<\/(?:h2|span|a)>/i) ||
                           cardHtml.match(/title="([^"]{10,})"/i) ||
                           cardHtml.match(/alt="([^"]{10,})"/i);
        const title = titleMatch ? decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, '')) : null;
        if (!title) continue;

        const priceMatch = cardHtml.match(/class="[^"]*(?:search-card-e-price-main|elements-offer-price-normal__price|searchx-price)[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div)>/i) ||
                           cardHtml.match(/(?:US\s*\$|\$)[\d,.]+(?:\s*-\s*[\d,.]+)?/i);
        const priceStr = priceMatch ? decodeHtmlEntities((priceMatch[1] || priceMatch[0]).replace(/<[^>]+>/g, '')) : null;

        const moqMatch = cardHtml.match(/class="[^"]*(?:search-card-e-num|element-offer-minorder-normal__value|searchx-moq)[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div)>/i) ||
                         cardHtml.match(/(\d[\d,]*\s*(?:pieces?|pcs|sets?|units?))/i);
        const moqStr = moqMatch ? decodeHtmlEntities(moqMatch[1].replace(/<[^>]+>/g, '')) : null;

        const isVerified = /verified/i.test(cardHtml);
        const hasTradeAssurance = /trade[- ]assurance|ta-icon/i.test(cardHtml);

        const imgMatch = cardHtml.match(/class="[^"]*(?:search-card-e-slider__img|searchx-img|image)[^"]*"[^>]*src="([^"]+)"/i) ||
                         cardHtml.match(/<img[^>]*src="([^"]+)"/i);
        const thumbnail = normalizeUrl(imgMatch ? imgMatch[1] : null);

        pushUnique({
            productId,
            title,
            priceRange: priceStr,
            minPrice: parseAlibabaPrice(priceStr),
            moq: moqStr,
            moqNumber: parseAlibabaMoq(moqStr),
            isVerified,
            hasTradeAssurance,
            thumbnail,
            url: cleanUrl,
            scrapedAt: new Date().toISOString(),
        });
    }

    // Layer 3: Anchor fallback for SSR catalog pages (e.g., /products/*.html)
    if (results.length === 0) {
        const anchorRegex = /<a[^>]*href="([^"]*\/product-detail\/[^"]+?_\d{8,}\.html[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
        for (const m of html.matchAll(anchorRegex)) {
            const cleanUrl = normalizeUrl(m[1])?.split('?')[0];
            const productId = extractAlibabaProductId(cleanUrl);
            const titleAttr = m[0].match(/title="([^"]{12,})"/i)?.[1] || m[0].match(/alt="([^"]{12,})"/i)?.[1];
            const innerTitle = m[2].replace(/<[^>]+>/g, ' ').trim();
            const title = decodeHtmlEntities(titleAttr || innerTitle);
            if (!productId || !title || title.length < 12) continue;
            pushUnique({
                productId,
                title,
                priceRange: null,
                minPrice: null,
                moq: null,
                moqNumber: null,
                isVerified: false,
                hasTradeAssurance: false,
                thumbnail: null,
                url: cleanUrl,
                scrapedAt: new Date().toISOString(),
            });
        }
    }

    return results;
}
