/**
 * Temu product/seller scraper.
 * Discovers sellers and products via Google-indexed Temu pages.
 */

import { fetchPage, sleep } from "../utils/http.js";

export interface TemuProduct {
  title: string;
  price: string;
  sellerName: string;
  category: string;
  productUrl: string;
  rating: string;
  soldCount: string;
  scrapedAt: string;
}

/**
 * Search for Temu products/sellers by keyword.
 */
export async function scrapeTemuProducts(
  keywords: string[],
  maxPerKeyword = 5
): Promise<TemuProduct[]> {
  const products: TemuProduct[] = [];

  for (const keyword of keywords) {
    console.log(`[Temu] Searching: "${keyword}"`);
    try {
      const searchUrl = `https://www.google.com/search?q=site:temu.com+"${encodeURIComponent(keyword)}"&num=${maxPerKeyword * 2}`;
      const $ = await fetchPage(searchUrl);

      $("div.g, div.tF2Cxc").each((_, result) => {
        if (products.length >= keywords.length * maxPerKeyword) return;

        const link = $(result).find("a").first().attr("href") || "";
        if (!link.includes("temu.com")) return;

        const title = $(result).find("h3").first().text().trim();
        const snippet = $(result).find(".VwiC3b, .s3v9rd").first().text().trim();

        const priceMatch = snippet.match(/\$[\d,.]+/);
        const soldMatch = snippet.match(/([\d,]+k?)\s*(?:sold|bought)/i);
        const ratingMatch = snippet.match(/([\d.]+)\s*(?:stars?|⭐)/i);

        products.push({
          title,
          price: priceMatch ? priceMatch[0] : "",
          sellerName: extractTemuSeller(title, snippet),
          category: keyword,
          productUrl: link,
          rating: ratingMatch ? ratingMatch[1] : "",
          soldCount: soldMatch ? soldMatch[1] : "",
          scrapedAt: new Date().toISOString(),
        });
      });

      await sleep(3000);
    } catch (err) {
      console.warn(`[Temu] Search failed for "${keyword}":`, err);
    }
  }

  console.log(`[Temu] Found ${products.length} products`);
  return products;
}

function extractTemuSeller(title: string, snippet: string): string {
  const text = title + " " + snippet;
  const sellerMatch = text.match(
    /(?:by|from|store|shop|seller)[:\s]+([A-Z][A-Za-z0-9\s]+?)(?:\s*[-|,.]|$)/i
  );
  return sellerMatch ? sellerMatch[1].trim() : "";
}
