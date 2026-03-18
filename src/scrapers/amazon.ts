/**
 * Amazon seller/product scraper.
 * Discovers sellers via product search pages and extracts seller profiles.
 * Note: Amazon aggressively blocks scrapers. Use conservatively.
 */

import { fetchPage, sleep } from "../utils/http.js";

export interface AmazonSeller {
  sellerName: string;
  sellerUrl: string;
  productTitle: string;
  price: string;
  rating: string;
  reviewCount: string;
  category: string;
  asin: string;
  scrapedAt: string;
}

/**
 * Search Amazon for products and extract seller information.
 */
export async function scrapeAmazonSellers(
  keywords: string[],
  maxPerKeyword = 5
): Promise<AmazonSeller[]> {
  const sellers: AmazonSeller[] = [];

  for (const keyword of keywords) {
    console.log(`[Amazon] Searching: "${keyword}"`);
    try {
      // Use Google to find Amazon product pages (avoids direct Amazon blocking)
      const searchUrl = `https://www.google.com/search?q=site:amazon.com+"${encodeURIComponent(keyword)}"+seller&num=${maxPerKeyword * 2}`;
      const $ = await fetchPage(searchUrl);

      $("div.g, div.tF2Cxc").each((_, result) => {
        if (sellers.length >= keywords.length * maxPerKeyword) return;

        const link = $(result).find("a").first().attr("href") || "";
        if (!link.includes("amazon.com")) return;

        const title = $(result).find("h3").first().text().trim();
        const snippet = $(result).find(".VwiC3b, .s3v9rd").first().text().trim();

        // Extract ASIN from URL
        const asinMatch = link.match(/\/dp\/([A-Z0-9]{10})/);
        const asin = asinMatch ? asinMatch[1] : "";

        // Extract price from snippet
        const priceMatch = snippet.match(/\$[\d,.]+/);

        // Extract rating
        const ratingMatch = snippet.match(/([\d.]+)\s*out of\s*5/);

        sellers.push({
          sellerName: extractSellerName(title, snippet),
          sellerUrl: link,
          productTitle: title,
          price: priceMatch ? priceMatch[0] : "",
          rating: ratingMatch ? ratingMatch[1] : "",
          reviewCount: "",
          category: keyword,
          asin,
          scrapedAt: new Date().toISOString(),
        });
      });

      await sleep(3000);
    } catch (err) {
      console.warn(`[Amazon] Search failed for "${keyword}":`, err);
    }
  }

  console.log(`[Amazon] Found ${sellers.length} seller listings`);
  return sellers;
}

function extractSellerName(title: string, snippet: string): string {
  // Try to find "by <seller>" or "sold by <seller>" patterns
  const byMatch = (title + " " + snippet).match(
    /(?:by|sold by|from)\s+([A-Z][A-Za-z0-9\s&]+?)(?:\s*[-|,.]|$)/
  );
  if (byMatch) return byMatch[1].trim();

  // Fallback: use first brand-like word
  const brandMatch = title.match(/^([A-Z][A-Za-z0-9]+)/);
  return brandMatch ? brandMatch[1] : "";
}
