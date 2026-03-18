import { fetchPage, sleep } from "../utils/http.js";

export interface ImportRecord {
  companyName: string;
  country: string;
  productDescription: string;
  hsCode: string;
  weight: string;
  shipmentCount: string;
  suppliers: string[];
  scrapedAt: string;
}

/**
 * Search ImportYeti for companies by keyword and scrape their import records.
 * ImportYeti is a public tool that visualizes US customs data.
 */
export async function scrapeImportYeti(
  keywords: string[],
  maxResultsPerKeyword = 10
): Promise<ImportRecord[]> {
  const allRecords: ImportRecord[] = [];

  for (const keyword of keywords) {
    console.log(`[ImportYeti] Searching: "${keyword}"`);

    try {
      const searchUrl = `https://www.importyeti.com/search?q=${encodeURIComponent(keyword)}`;
      const $ = await fetchPage(searchUrl);

      // Parse search results - company cards
      const companyLinks: string[] = [];
      $("a[href*='/company/']").each((_, el) => {
        const href = $(el).attr("href");
        if (href && companyLinks.length < maxResultsPerKeyword) {
          const fullUrl = href.startsWith("http")
            ? href
            : `https://www.importyeti.com${href}`;
          if (!companyLinks.includes(fullUrl)) {
            companyLinks.push(fullUrl);
          }
        }
      });

      console.log(
        `[ImportYeti] Found ${companyLinks.length} companies for "${keyword}"`
      );

      // Scrape each company page
      for (const companyUrl of companyLinks) {
        try {
          await sleep(1500 + Math.random() * 1500); // polite delay
          const record = await scrapeCompanyPage(companyUrl);
          if (record) {
            allRecords.push(record);
          }
        } catch (err) {
          console.warn(`[ImportYeti] Failed to scrape ${companyUrl}:`, err);
        }
      }
    } catch (err) {
      console.error(`[ImportYeti] Search failed for "${keyword}":`, err);
    }

    await sleep(2000); // delay between keywords
  }

  return allRecords;
}

async function scrapeCompanyPage(
  url: string
): Promise<ImportRecord | null> {
  const $ = await fetchPage(url);

  const companyName =
    $("h1").first().text().trim() ||
    $(".company-name").first().text().trim();

  if (!companyName) return null;

  // Extract key data points from the company page
  const country = extractText($, [
    ".country",
    '[data-field="country"]',
    "td:contains('Country') + td",
  ]);

  const productDescription = extractText($, [
    ".product-description",
    '[data-field="product"]',
    "td:contains('Product') + td",
  ]);

  const hsCode = extractText($, [
    ".hs-code",
    '[data-field="hs-code"]',
    "td:contains('HS Code') + td",
  ]);

  const weight = extractText($, [
    ".weight",
    '[data-field="weight"]',
    "td:contains('Weight') + td",
  ]);

  const shipmentCount = extractText($, [
    ".shipment-count",
    '[data-field="shipments"]',
    "td:contains('Shipment') + td",
  ]);

  // Extract supplier names
  const suppliers: string[] = [];
  $("a[href*='/company/']").each((_, el) => {
    const text = $(el).text().trim();
    if (text && text !== companyName && !suppliers.includes(text)) {
      suppliers.push(text);
    }
  });

  return {
    companyName,
    country: country || "Unknown",
    productDescription: productDescription || "",
    hsCode: hsCode || "",
    weight: weight || "",
    shipmentCount: shipmentCount || "",
    suppliers: suppliers.slice(0, 20),
    scrapedAt: new Date().toISOString(),
  };
}

function extractText(
  $: ReturnType<typeof import("cheerio").load>,
  selectors: string[]
): string {
  for (const sel of selectors) {
    const text = $(sel).first().text().trim();
    if (text) return text;
  }
  return "";
}
