import { chromium, type Browser, type Page } from "playwright";
import type { ImportRecord } from "./importyeti.js";

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
  return browser;
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

/**
 * Playwright-based ImportYeti scraper.
 * Handles JS-rendered content, infinite scroll, and dynamic loading.
 */
export async function scrapeImportYetiWithPlaywright(
  keywords: string[],
  maxResultsPerKeyword = 10
): Promise<ImportRecord[]> {
  const b = await getBrowser();
  const allRecords: ImportRecord[] = [];

  for (const keyword of keywords) {
    console.log(`[Playwright] Searching ImportYeti: "${keyword}"`);
    const page = await b.newPage();

    try {
      // Set realistic viewport and user agent
      await page.setViewportSize({ width: 1920, height: 1080 });

      const searchUrl = `https://www.importyeti.com/search?q=${encodeURIComponent(keyword)}`;
      await page.goto(searchUrl, { waitUntil: "networkidle", timeout: 30000 });

      // Wait for results to render
      await page.waitForTimeout(2000);

      // Scroll to load more results
      await autoScroll(page);

      // Extract company links
      const companyLinks = await page.evaluate((max) => {
        const links: string[] = [];
        document.querySelectorAll('a[href*="/company/"]').forEach((el) => {
          const href = (el as HTMLAnchorElement).href;
          if (href && !links.includes(href) && links.length < max) {
            links.push(href);
          }
        });
        return links;
      }, maxResultsPerKeyword);

      console.log(
        `[Playwright] Found ${companyLinks.length} companies for "${keyword}"`
      );

      // Scrape each company page
      for (const companyUrl of companyLinks) {
        try {
          const record = await scrapeCompanyWithPlaywright(page, companyUrl);
          if (record) {
            allRecords.push(record);
          }
          // Polite delay
          await page.waitForTimeout(1500 + Math.random() * 1500);
        } catch (err) {
          console.warn(`[Playwright] Failed: ${companyUrl}`, err);
        }
      }
    } catch (err) {
      console.error(`[Playwright] Search failed for "${keyword}":`, err);
    } finally {
      await page.close();
    }

    // Delay between keywords
    await new Promise((r) => setTimeout(r, 2000));
  }

  return allRecords;
}

async function scrapeCompanyWithPlaywright(
  page: Page,
  url: string
): Promise<ImportRecord | null> {
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(1500);

  const data = await page.evaluate(() => {
    const getText = (selectors: string[]): string => {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el?.textContent?.trim()) return el.textContent.trim();
      }
      return "";
    };

    const companyName = getText(["h1", ".company-name"]);
    if (!companyName) return null;

    // Try to extract from structured data / tables / cards
    const country = getText([
      ".country",
      '[data-field="country"]',
      "td:nth-child(2)", // fallback to table cells
    ]);

    const productDescription = getText([
      ".product-description",
      '[data-field="product"]',
    ]);

    const hsCode = getText([".hs-code", '[data-field="hs-code"]']);
    const weight = getText([".weight", '[data-field="weight"]']);
    const shipmentCount = getText([
      ".shipment-count",
      '[data-field="shipments"]',
    ]);

    // Extract suppliers
    const suppliers: string[] = [];
    document.querySelectorAll('a[href*="/company/"]').forEach((el) => {
      const text = el.textContent?.trim();
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
    };
  });

  if (!data) return null;

  return {
    ...data,
    scrapedAt: new Date().toISOString(),
  };
}

async function autoScroll(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let totalHeight = 0;
      const distance = 400;
      const maxScrolls = 10;
      let scrollCount = 0;

      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        scrollCount++;

        if (
          totalHeight >= document.body.scrollHeight - window.innerHeight ||
          scrollCount >= maxScrolls
        ) {
          clearInterval(timer);
          resolve();
        }
      }, 300);
    });
  });
}
