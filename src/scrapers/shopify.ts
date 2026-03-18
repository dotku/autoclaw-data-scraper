/**
 * Shopify store scraper.
 * Discovers Shopify-powered stores via Google search and scrapes
 * public store info, product data, and seller details.
 */

import { fetchPage, sleep } from "../utils/http.js";

export interface ShopifyStore {
  storeName: string;
  storeUrl: string;
  description: string;
  products: ShopifyProduct[];
  contactEmail: string;
  country: string;
  scrapedAt: string;
}

export interface ShopifyProduct {
  title: string;
  price: string;
  vendor: string;
  productType: string;
  url: string;
}

/**
 * Find and scrape Shopify stores by keyword.
 * Uses Google dorks to find Shopify-powered stores.
 */
export async function scrapeShopifyStores(
  keywords: string[],
  maxPerKeyword = 5
): Promise<ShopifyStore[]> {
  const stores: ShopifyStore[] = [];

  for (const keyword of keywords) {
    console.log(`[Shopify] Searching: "${keyword}"`);
    try {
      // Google dork for Shopify stores
      const searchUrl = `https://www.google.com/search?q="${encodeURIComponent(keyword)}"+site:myshopify.com+OR+"powered+by+shopify"&num=${maxPerKeyword * 2}`;
      const $ = await fetchPage(searchUrl);

      const storeUrls: string[] = [];
      $("a[href]").each((_, el) => {
        const href = $(el).attr("href") || "";
        const match = href.match(/(https?:\/\/[^/]*(?:myshopify\.com|\.com)[^&]*)/);
        if (match && storeUrls.length < maxPerKeyword) {
          const url = match[1].split("&")[0];
          if (!storeUrls.includes(url)) storeUrls.push(url);
        }
      });

      for (const url of storeUrls) {
        try {
          const store = await scrapeShopifyStore(url);
          if (store) stores.push(store);
          await sleep(2000);
        } catch {
          console.warn(`[Shopify] Failed: ${url}`);
        }
      }
    } catch (err) {
      console.warn(`[Shopify] Search failed for "${keyword}":`, err);
    }
    await sleep(2000);
  }

  return stores;
}

async function scrapeShopifyStore(baseUrl: string): Promise<ShopifyStore | null> {
  // Shopify stores expose products.json publicly
  const productsUrl = `${baseUrl.replace(/\/$/, "")}/products.json?limit=10`;

  try {
    const res = await fetch(productsUrl, {
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      // Fallback to HTML scraping
      return await scrapeShopifyHTML(baseUrl);
    }

    const json = (await res.json()) as {
      products: Record<string, unknown>[];
    };

    const products: ShopifyProduct[] = (json.products || []).map((p) => ({
      title: (p.title as string) || "",
      price: ((p.variants as Record<string, unknown>[])?.[ 0]?.price as string) || "",
      vendor: (p.vendor as string) || "",
      productType: (p.product_type as string) || "",
      url: `${baseUrl}/products/${p.handle}`,
    }));

    const storeName =
      products[0]?.vendor || new URL(baseUrl).hostname.replace(".myshopify.com", "");

    return {
      storeName,
      storeUrl: baseUrl,
      description: (json.products[0]?.body_html as string)?.replace(/<[^>]*>/g, "").slice(0, 300) || "",
      products,
      contactEmail: "",
      country: "",
      scrapedAt: new Date().toISOString(),
    };
  } catch {
    return await scrapeShopifyHTML(baseUrl);
  }
}

async function scrapeShopifyHTML(url: string): Promise<ShopifyStore | null> {
  try {
    const $ = await fetchPage(url);
    const storeName = $("title").first().text().trim().split("|")[0].trim() ||
      $('meta[property="og:site_name"]').attr("content") || "";

    if (!storeName) return null;

    const description = $('meta[name="description"]').attr("content") ||
      $('meta[property="og:description"]').attr("content") || "";

    // Try to find contact email
    const emailMatch = $.html().match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);

    return {
      storeName,
      storeUrl: url,
      description: description.slice(0, 300),
      products: [],
      contactEmail: emailMatch ? emailMatch[0] : "",
      country: "",
      scrapedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
