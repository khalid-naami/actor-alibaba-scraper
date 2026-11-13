/**
 * Alibaba B2B Product & Supplier Extraction Handlers
 */

/**
 * Extract Alibaba product ID from URL
 */
export function extractAlibabaProductId(url) {
    if (!url || typeof url !== 'string') return null;
    const match = url.match(/_(\d{8,})\.html/) || url.match(/productId=(\d{8,})/);
    return match ? match[1] : null;
}

/**
 * Clean numeric price from string
 */
export function parseAlibabaPrice(raw) {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    if (!raw || typeof raw !== 'string') return null;
    const cleaned = raw.replace(/[^\d.]/g, '');
    const num = parseFloat(cleaned);
    return Number.isFinite(num) ? num : null;
}

/**
 * Parse numeric MOQ count (e.g. "100 Pieces" -> 100)
 */
export function parseAlibabaMoq(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const match = raw.replace(/,/g, '').match(/(\d+)/);
    return match ? parseInt(match[1], 10) : null;
}

/**
 * Extract product details from Alibaba Product Detail HTML
 */
export function parseAlibabaProductHtml(html, url = '') {
    if (!html) return null;

    const productId = extractAlibabaProductId(url);

    // Title
    let title = null;
    const titleMatch = html.match(/class="[^"]*(?:product-title|module-pdp-title)[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) ||
                       html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (titleMatch) {
        title = titleMatch[1].replace(/<[^>]+>/g, '').trim();
    }

    // Price & Bulk Pricing Tiers
    const bulkPricing = [];
    let priceRange = null;
    let minPrice = null;
    let maxPrice = null;

    // Pattern 1: Ladder price elements
    const ladderMatches = [...html.matchAll(/class="[^"]*(?:ladder-price-item|price-item)[^"]*"[\s\S]*?(?=(?:class="[^"]*(?:ladder-price-item|price-item)"|$))/gi)];
    for (const lm of ladderMatches) {
        const itemHtml = lm[0];
        const qtyMatch = itemHtml.match(/class="[^"]*quantity[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
        const pMatch = itemHtml.match(/class="[^"]*price[^"]*"[^>]*>([\s\S]*?)<\/span>/i);

        if (pMatch) {
            const pVal = parseAlibabaPrice(pMatch[1]);
            const qStr = qtyMatch ? qtyMatch[1].replace(/<[^>]+>/g, '').trim() : '';
            if (pVal !== null) {
                bulkPricing.push({
                    quantity: qStr || 'Default',
                    price: pVal,
                });
            }
        }
    }

    // Pattern 2: Global price range string
    const rangeMatch = html.match(/class="[^"]*(?:price-range|module-price|promotion-price)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span)>/i) ||
                       html.match(/"price":"([^"]+)"/);
    if (rangeMatch) {
        priceRange = rangeMatch[1].replace(/<[^>]+>/g, '').trim();
        const prices = [...priceRange.matchAll(/([0-9]+\.[0-9]{2}|[0-9]+)/g)].map((m) => parseFloat(m[1]));
        if (prices.length > 0) {
            minPrice = Math.min(...prices);
            maxPrice = Math.max(...prices);
        }
    }

    if (bulkPricing.length > 0 && minPrice === null) {
        const pList = bulkPricing.map((b) => b.price);
        minPrice = Math.min(...pList);
        maxPrice = Math.max(...pList);
    }

    // Currency
    let currency = 'USD';
    if (html.includes('€') || html.includes('EUR')) currency = 'EUR';
    else if (html.includes('£') || html.includes('GBP')) currency = 'GBP';

    // MOQ (Minimum Order Quantity)
    let moq = '1 Piece';
    let moqNumber = 1;
    const moqMatch = html.match(/(?:Min\. order|Minimum order quantity|MOQ):?\s*([^<"\n]+)/i) ||
                     html.match(/class="[^"]*moq-number[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    if (moqMatch) {
        moq = moqMatch[1].replace(/<[^>]+>/g, '').trim();
        moqNumber = parseAlibabaMoq(moq) || 1;
    }

    // Supplier Information
    let supplierName = null;
    let supplierYears = null;
    let supplierCountry = 'CN';
    const supplierMatch = html.match(/class="[^"]*company-name[^"]*"[^>]*>([\s\S]*?)<\/(?:a|span|div)>/i) ||
                          html.match(/href="[^"]*company_profile[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    if (supplierMatch) {
        supplierName = supplierMatch[1].replace(/<[^>]+>/g, '').trim();
    }

    const yearMatch = html.match(/(\d+)\s*(?:YRS|yrs|Years)/i);
    if (yearMatch) {
        supplierYears = `${yearMatch[1]} yrs`;
    }

    // Verified & Trade Assurance badges
    const isVerified = html.includes('verified-supplier') || html.includes('Verified Supplier') || html.includes('icon-verified');
    const hasTradeAssurance = html.includes('trade-assurance') || html.includes('Trade Assurance') || html.includes('icon-ta');

    // Reviews & Rating
    let reviewScore = null;
    let reviewsCount = 0;
    const scoreMatch = html.match(/class="[^"]*(?:star-score|rating-score|score-text)[^"]*"[^>]*>([0-5]\.[0-9]|[0-5])<\/span>/i) ||
                       html.match(/"score":([0-5]\.[0-9]|[0-5])/);
    if (scoreMatch) {
        reviewScore = parseFloat(scoreMatch[1]);
    }

    const countMatch = html.match(/(\d[\d,]*)\s*(?:Reviews|Ratings|reviews)/i);
    if (countMatch) {
        reviewsCount = parseInt(countMatch[1].replace(/,/g, ''), 10) || 0;
    }

    // Lead Time
    let leadTime = null;
    const leadMatch = html.match(/(?:Lead time|Lead Time):?\s*([^<"\n]+)/i);
    if (leadMatch) {
        leadTime = leadMatch[1].replace(/<[^>]+>/g, '').trim();
    }

    // Customization options
    const customization = [];
    if (html.toLowerCase().includes('customized logo')) customization.push('Customized logo');
    if (html.toLowerCase().includes('customized packaging')) customization.push('Customized packaging');
    if (html.toLowerCase().includes('graphic customization')) customization.push('Graphic customization');

    // High-resolution Images
    const images = [];
    const imgMatches = [...html.matchAll(/class="[^"]*(?:main-img|image-item|thumb)[^"]*"[^>]*src="([^"]+)"/gi)];
    for (const m of imgMatches) {
        let src = m[1];
        if (src.startsWith('//')) src = `https:${src}`;
        src = src.replace(/_\d+x\d+.*\.jpg$/, '');
        images.push(src);
    }

    const thumbnail = images[0] || null;

    return {
        productId,
        title,
        priceRange: priceRange || (minPrice ? `$${minPrice}` : null),
        minPrice,
        maxPrice,
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
        thumbnail,
        images: [...new Set(images)],
        url,
        scrapedAt: new Date().toISOString(),
    };
}

/**
 * Extract items from Alibaba search results page HTML
 */
export function parseAlibabaSearchHtml(html) {
    const results = [];
    if (!html) return results;

    const cards = [...html.matchAll(/class="[^"]*(?:fy23-search-card|list-no-v2-outer|organic-gallery-offer)[^"]*"[\s\S]*?(?=(?:class="[^"]*(?:fy23-search-card|list-no-v2-outer|organic-gallery-offer)"|$))/gi)];

    for (const c of cards) {
        const cardHtml = c[0];

        // Link & Title
        const linkMatch = cardHtml.match(/href="(\/\/[^"]*alibaba\.com\/product-detail\/[^"]+)"/i) ||
                          cardHtml.match(/href="([^"]*\/product-detail\/[^"]+)"/i);
        if (!linkMatch) continue;

        let href = linkMatch[1];
        if (href.startsWith('//')) href = `https:${href}`;
        const cleanUrl = href.split('?')[0];
        const productId = extractAlibabaProductId(cleanUrl);

        const titleMatch = cardHtml.match(/class="[^"]*(?:search-card-e-title|elements-title-normal__outter)[^"]*"[^>]*>([\s\S]*?)<\/(?:h2|span|a)>/i);
        const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : null;

        if (!title) continue;

        // Price
        const priceMatch = cardHtml.match(/class="[^"]*(?:search-card-e-price-main|elements-offer-price-normal__price)[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
        const priceStr = priceMatch ? priceMatch[1].replace(/<[^>]+>/g, '').trim() : null;

        // MOQ
        const moqMatch = cardHtml.match(/class="[^"]*(?:search-card-e-num|element-offer-minorder-normal__value)[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
        const moqStr = moqMatch ? moqMatch[1].replace(/<[^>]+>/g, '').trim() : null;

        // Supplier & Badges
        const isVerified = cardHtml.includes('verified-icon') || cardHtml.includes('Verified');
        const hasTradeAssurance = cardHtml.includes('ta-icon') || cardHtml.includes('Trade Assurance');

        // Thumbnail
        const imgMatch = cardHtml.match(/class="[^"]*(?:search-card-e-slider__img|image)[^"]*"[^>]*src="([^"]+)"/i);
        let thumbnail = imgMatch ? imgMatch[1] : null;
        if (thumbnail && thumbnail.startsWith('//')) thumbnail = `https:${thumbnail}`;

        results.push({
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

    return results;
}
