# 🏭 Alibaba B2B Wholesale Scraper (MOQ, Bulk Price Tiers & Suppliers)

Extract live Alibaba wholesale products, tiered volume pricing, Minimum Order Quantity (MOQ), Verified Supplier credentials, Trade Assurance status, and manufacturing specs at scale.

> **Apify Store Short Description (297 chars):**  
> `Scrape Alibaba B2B products, wholesale bulk price tiers, MOQ (Minimum Order Quantity), Verified Supplier credentials, Trade Assurance, and factory specs at scale. Supports direct product URLs and keyword searches with proxy rotation for Amazon FBA sourcing, global imports, and trade intelligence.`

---

## 🌟 Key Features

- 💰 **Tiered Volume Pricing**: Captures bulk price ladders across all order quantities (e.g. 1-99 pcs, 100-499 pcs, 500+ pcs).
- 📦 **MOQ Intelligence**: Extracts Minimum Order Quantity in formatted text ("100 Sets") and clean numeric counts.
- 🏢 **Supplier Verification Badges**: Identifies Verified Suppliers, Verified Pro badges, and operating years on Alibaba.
- 🛡️ **Trade Assurance Tracking**: Filters and marks suppliers eligible for Alibaba Trade Assurance buyer protection.
- ⏱️ **Production Lead Times**: Extracts estimated dispatch schedules based on order volume.
- 🎨 **OEM / ODM Customization**: Captures customization capabilities (Customized Logo, Packaging, Graphic Customization).
- 🔍 **Dual Input Mode**: Input direct Alibaba product detail URLs or search keywords across product categories.
- ⚡ **Anti-Bot & Punish Page Bypass**: High-performance HTTP client backed by residential proxies and headless browser fallback.

---

## 📥 Input Configuration

| Field | Type | Default | Description |
|---|---|---|---|
| `productUrls` | Array | `[]` | List of direct Alibaba product detail URLs. |
| `searchKeywords` | Array | `["bamboo cutting board"]` | Keywords to search on Alibaba (falls back to this keyword if both `productUrls` and `searchKeywords` are empty). |
| `verifiedSupplierOnly` | Boolean | `false` | Filter search results to only verified manufacturing suppliers. |
| `tradeAssuranceOnly` | Boolean | `false` | Filter search results to products with Trade Assurance protection. |
| `maxProducts` | Integer | `40` | Maximum products to extract per search keyword. |
| `proxyConfiguration` | Object | `{ "useApifyProxy": true }` | Apify Proxy settings to bypass Alibaba IP blocks. |

---

## 📤 Output Data Format

```json
{
  "productId": "1600123456789",
  "title": "Eco-friendly Organic Bamboo Kitchen Cutting Board with Juice Groove",
  "priceRange": "$3.20 - $5.50 / Piece",
  "minPrice": 3.20,
  "maxPrice": 5.50,
  "currency": "USD",
  "moq": "100 Pieces",
  "moqNumber": 100,
  "bulkPricing": [
    { "quantity": "100 - 499 Pieces", "price": 5.50 },
    { "quantity": "500 - 1999 Pieces", "price": 4.20 },
    { "quantity": ">= 2000 Pieces", "price": 3.20 }
  ],
  "supplierName": "Fujian Bamboo Crafts Manufacturing Co., Ltd.",
  "supplierYears": "8 yrs",
  "supplierCountry": "CN",
  "isVerified": true,
  "hasTradeAssurance": true,
  "reviewScore": 4.9,
  "reviewsCount": 218,
  "leadTime": "15 days for 100-500 pcs",
  "customization": [
    "Customized logo",
    "Customized packaging",
    "Graphic customization"
  ],
  "thumbnail": "https://s.alicdn.com/@sc04/kf/H123456789.jpg",
  "images": [
    "https://s.alicdn.com/@sc04/kf/H123456789.jpg",
    "https://s.alicdn.com/@sc04/kf/H987654321.jpg"
  ],
  "url": "https://www.alibaba.com/product-detail/Eco-friendly-Organic-Bamboo-Kitchen-Cutting-Board_1600123456789.html",
  "scrapedAt": "2026-11-10T11:55:00.000Z"
}
```

---

## 💡 Practical Commercial Use Cases

1. **Amazon FBA & Private Label Sourcing**: Discover reliable factories with low MOQs and compare bulk production costs against Amazon retail prices.
2. **Wholesale Margin Calculation**: Map exact volume discount tiers to calculate profit margins at different order quantities.
3. **Supplier Due Diligence**: Filter only Verified Suppliers with high review scores and Trade Assurance coverage to minimize import risks.
4. **B2B Market Research**: Track manufacturing trends, OEM capabilities, and raw material pricing from primary Asian factories.

---

## ⚖️ License
Apache-2.0
