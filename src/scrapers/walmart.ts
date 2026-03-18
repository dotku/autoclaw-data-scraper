/**
 * Walmart Marketplace seller scraper.
 * Discovers third-party sellers and products via Google-indexed pages.
 */

import { fetchPage, sleep } from "../utils/http.js";

export interface WalmartSeller {
  sellerName: string;
  productTitle: string;
  price: string;
  productUrl: string;
  rating: string;
  category: string;
  scrapedAt: string;
}

/**
 * Search for Walmart Marketplace sellers by keyword.
 */
export async function scrapeWalmartSellers(
  keywords: string[],
  maxPerKeyword = 5
): Promise<WalmartSeller[]> {
  const sellers: WalmartSeller[] = [];

  for (const keyword of keywords) {
    console.log(`[Walmart] Searching: "${keyword}"`);
    try {
      const searchUrl = `https://www.google.com/search?q=site:walmart.com+"${encodeURIComponent(keyword)}"+seller+OR+"sold+by"&num=${maxPerKeyword * 2}`;
      const $ = await fetchPage(searchUrl);

      $("div.g, div.tF2Cxc").each((_, result) => {
        if (sellers.length >= keywords.length * maxPerKeyword) return;

        const link = $(result).find("a").first().attr("href") || "";
        if (!link.includes("walmart.com")) return;

        const title = $(result).find("h3").first().text().trim();
        const snippet = $(result).find(".VwiC3b, .s3v9rd").first().text().trim();

        const priceMatch = snippet.match(/\$[\d,.]+/);
        const ratingMatch = snippet.match(/([\d.]+)\s*(?:stars?|out of)/i);

        // Extract seller name
        const sellerMatch = (title + " " + snippet).match(
          /(?:sold by|seller|by|from)\s+([A-Z][A-Za-z0-9\s&]+?)(?:\s*[-|,.\n]|$)/i
        );

        sellers.push({
          sellerName: sellerMatch ? sellerMatch[1].trim() : "",
          productTitle: title,
          price: priceMatch ? priceMatch[0] : "",
          productUrl: link,
          rating: ratingMatch ? ratingMatch[1] : "",
          category: keyword,
          scrapedAt: new Date().toISOString(),
        });
      });

      await sleep(3000);
    } catch (err) {
      console.warn(`[Walmart] Search failed for "${keyword}":`, err);
    }
  }

  console.log(`[Walmart] Found ${sellers.length} seller listings`);
  return sellers;
}
