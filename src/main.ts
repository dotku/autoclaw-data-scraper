import fs from "fs/promises";
import path from "path";
import { scrapeImportYeti } from "./scrapers/importyeti.js";
import {
  scrapeImportYetiWithPlaywright,
  closeBrowser,
} from "./scrapers/playwright-scraper.js";
import { enrichBatch, type EnrichedCompanyData } from "./scrapers/apollo.js";
import { fetchOECBatch, COMMON_HS_CODES } from "./scrapers/oec.js";
import { fetchWITSBatch, US_IMPORT_QUERIES } from "./scrapers/wits.js";
import { linkedInBatchLookup } from "./scrapers/linkedin.js";
import { scrapeShopifyStores } from "./scrapers/shopify.js";
import { scrapeAmazonSellers } from "./scrapers/amazon.js";
import { scrapeTemuProducts } from "./scrapers/temu.js";
import { scrapeWalmartSellers } from "./scrapers/walmart.js";
import { analyzeTradeData } from "./llm/gemini.js";
import { buildOutreachTargets } from "./outreach/template-builder.js";
import { generateOutreachBatch } from "./outreach/email-generator.js";
import { generateStatsReport } from "./report/stats.js";

// --- Configuration ---
const SEARCH_KEYWORDS = [
  "wholesale electronics",
  "LED lighting",
  "solar panel",
  "beauty products",
  "kitchen appliances",
];

const ECOMMERCE_KEYWORDS = [
  "wholesale supplier",
  "bulk electronics",
  "LED manufacturer",
  "beauty wholesale",
];

const OEC_HS_CODES = Object.keys(COMMON_HS_CODES).slice(0, 5);

const DATA_DIR = path.resolve(import.meta.dirname, "../data");
const REPORT_DIR = path.resolve(import.meta.dirname, "../data/reports");
const MAX_RESULTS_PER_KEYWORD = 5;

// --- Main ---
async function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes("--dry-run");
  const usePlaywright = args.includes("--use-playwright");
  const skipEnrich = args.includes("--skip-enrich");
  const skipLLM = args.includes("--skip-llm");
  const skipOutreach = args.includes("--skip-outreach");
  const skipEcommerce = args.includes("--skip-ecommerce");
  const skipReport = args.includes("--skip-report");

  console.log("=== AutoClaw Data Scraper ===");
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Mode: ${isDryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`Scraper: ${usePlaywright ? "Playwright" : "Cheerio"}`);
  console.log("");

  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(REPORT_DIR, { recursive: true });
  const today = new Date().toISOString().split("T")[0];

  if (isDryRun) {
    console.log("[DRY RUN] ImportYeti keywords:", SEARCH_KEYWORDS);
    console.log("[DRY RUN] OEC HS codes:", OEC_HS_CODES);
    console.log("[DRY RUN] WITS queries:", US_IMPORT_QUERIES.length);
    console.log("[DRY RUN] E-commerce keywords:", ECOMMERCE_KEYWORDS);
    console.log("[DRY RUN] + Apollo enrich → Gemini analysis → Outreach emails → Stats report");
    return;
  }

  const stats: Record<string, unknown> = { date: today, sources: {} };

  // ─── Step 1: ImportYeti ───
  console.log("\n--- Step 1: Scraping ImportYeti ---");
  const importRecords = usePlaywright
    ? await scrapeImportYetiWithPlaywright(SEARCH_KEYWORDS, MAX_RESULTS_PER_KEYWORD)
    : await scrapeImportYeti(SEARCH_KEYWORDS, MAX_RESULTS_PER_KEYWORD);

  if (usePlaywright) await closeBrowser();

  await saveJSON(DATA_DIR, `importyeti-${today}.json`, importRecords);
  (stats.sources as Record<string, unknown>).importyeti = importRecords.length;

  // ─── Step 2: OEC Trade Flows ───
  console.log("\n--- Step 2: OEC Trade Flows ---");
  const oecFlows = await fetchOECBatch(OEC_HS_CODES);
  await saveJSON(DATA_DIR, `oec-${today}.json`, oecFlows);
  (stats.sources as Record<string, unknown>).oec = oecFlows.length;

  // ─── Step 3: WITS World Bank ───
  console.log("\n--- Step 3: WITS Trade Data ---");
  const witsRecords = await fetchWITSBatch(US_IMPORT_QUERIES);
  await saveJSON(DATA_DIR, `wits-${today}.json`, witsRecords);
  (stats.sources as Record<string, unknown>).wits = witsRecords.length;

  // ─── Step 4: E-commerce Platforms ───
  if (!skipEcommerce) {
    console.log("\n--- Step 4: E-commerce Platforms ---");

    const [shopifyResults, amazonResults, temuResults, walmartResults] =
      await Promise.allSettled([
        scrapeShopifyStores(ECOMMERCE_KEYWORDS),
        scrapeAmazonSellers(ECOMMERCE_KEYWORDS),
        scrapeTemuProducts(ECOMMERCE_KEYWORDS),
        scrapeWalmartSellers(ECOMMERCE_KEYWORDS),
      ]);

    const ecomData = {
      shopify: shopifyResults.status === "fulfilled" ? shopifyResults.value : [],
      amazon: amazonResults.status === "fulfilled" ? amazonResults.value : [],
      temu: temuResults.status === "fulfilled" ? temuResults.value : [],
      walmart: walmartResults.status === "fulfilled" ? walmartResults.value : [],
    };
    await saveJSON(DATA_DIR, `ecommerce-${today}.json`, ecomData);
    (stats.sources as Record<string, unknown>).shopify = ecomData.shopify.length;
    (stats.sources as Record<string, unknown>).amazon = ecomData.amazon.length;
    (stats.sources as Record<string, unknown>).temu = ecomData.temu.length;
    (stats.sources as Record<string, unknown>).walmart = ecomData.walmart.length;
  }

  // ─── Step 5: LinkedIn ───
  console.log("\n--- Step 5: LinkedIn Lookup ---");
  const companyNames = importRecords
    .map((r) => r.companyName)
    .filter(Boolean)
    .slice(0, 10);
  const linkedInData = await linkedInBatchLookup(companyNames, { findPeople: true });
  await saveJSON(DATA_DIR, `linkedin-${today}.json`, linkedInData);
  (stats.sources as Record<string, unknown>).linkedin = {
    companies: linkedInData.companies.length,
    people: linkedInData.people.length,
  };

  // ─── Step 6: Apollo Enrich ───
  let enrichedData: EnrichedCompanyData[] = [];
  if (!skipEnrich && process.env.APOLLO_API_KEY) {
    console.log("\n--- Step 6: Apollo Enrichment ---");
    enrichedData = await enrichBatch(importRecords, { findContactsForEach: true });
    await saveJSON(DATA_DIR, `enriched-${today}.json`, enrichedData);
    (stats.sources as Record<string, unknown>).apollo = enrichedData.length;
  }

  // ─── Step 7: Gemini Analysis ───
  if (!skipLLM && process.env.GEMINI_API_KEY) {
    console.log("\n--- Step 7: Gemini Analysis ---");
    try {
      const allData = { importRecords, oecFlows, witsRecords };
      const analysis = await analyzeTradeData(
        [allData] as unknown as Record<string, unknown>[]
      );
      await fs.writeFile(path.join(DATA_DIR, `analysis-${today}.json`), analysis);
    } catch (err) {
      console.error("LLM analysis failed:", err);
    }
  }

  // ─── Step 8: Generate Outreach Emails ───
  if (!skipOutreach && process.env.GEMINI_API_KEY) {
    console.log("\n--- Step 8: Outreach Email Generation ---");
    const targets = buildOutreachTargets({
      importRecords,
      enrichedData: enrichedData.length > 0 ? enrichedData : undefined,
      linkedInCompanies: linkedInData.companies,
      linkedInPeople: linkedInData.people,
      tradeFlows: oecFlows,
    });

    console.log(`Built ${targets.length} outreach targets`);

    // Generate emails for top targets (up to 10 per run to stay in free tier)
    const topTargets = targets.slice(0, 10);
    const emails = await generateOutreachBatch(topTargets, { tone: "friendly" });
    await saveJSON(DATA_DIR, `outreach-${today}.json`, emails);
    (stats.sources as Record<string, unknown>).outreach = emails.length;
  }

  // ─── Step 9: Generate Stats Report ───
  if (!skipReport) {
    console.log("\n--- Step 9: Generating Stats Report ---");
    const reportHtml = await generateStatsReport(DATA_DIR, today);
    const reportPath = path.join(REPORT_DIR, `report-${today}.html`);
    await fs.writeFile(reportPath, reportHtml);
    console.log(`Report saved to ${reportPath}`);
  }

  // ─── Summary ───
  await saveJSON(DATA_DIR, `stats-${today}.json`, stats);
  console.log("\n--- Summary ---");
  console.log(JSON.stringify(stats, null, 2));
  console.log("\n=== Done ===");
}

async function saveJSON(dir: string, filename: string, data: unknown) {
  const filepath = path.join(dir, filename);
  await fs.writeFile(filepath, JSON.stringify(data, null, 2));
  const count = Array.isArray(data) ? data.length : "object";
  console.log(`Saved ${count} → ${filepath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
