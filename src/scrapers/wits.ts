/**
 * World Integrated Trade Solution (WITS) scraper.
 * WITS is a World Bank trade data platform with a public API.
 * API docs: https://wits.worldbank.org/API/V1/SDMX/V21/rest
 *
 * Free, no API key required.
 */

import { sleep } from "../utils/http.js";

const WITS_API = "https://wits.worldbank.org/API/V1/SDMX/V21/rest";

export interface WITSTradeRecord {
  reporter: string;
  partner: string;
  productCode: string;
  productDescription: string;
  year: number;
  tradeFlow: "Import" | "Export";
  tradeValue: number;
  indicator: string;
  scrapedAt: string;
}

/**
 * Fetch trade summary data from WITS API.
 * Uses the SDMX REST API for structured trade statistics.
 *
 * @param reporterIso - Reporter country ISO3 (e.g., "USA")
 * @param partnerIso - Partner country ISO3 (e.g., "CHN"), or "WLD" for world
 * @param productCode - HS code (e.g., "850440" or "UNCTAD-SoP1" for broad categories)
 * @param year - Trade year
 */
export async function fetchWITSTrade(
  reporterIso: string,
  partnerIso: string,
  productCode: string,
  year?: number
): Promise<WITSTradeRecord[]> {
  const tradeYear = year || new Date().getFullYear() - 1;

  // WITS also provides a simpler JSON endpoint
  const simpleUrl = `https://wits.worldbank.org/API/V1/SDMX/V21/datasource/tradestats-trade/reporter/${reporterIso}/year/${tradeYear}/partner/${partnerIso}/product/${productCode}/indicator/MPRT-TRD-VL`;

  console.log(`[WITS] Fetching: ${reporterIso} ← ${partnerIso}, HS${productCode} (${tradeYear})`);

  try {
    const res = await fetch(simpleUrl, {
      headers: {
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      // WITS often returns XML even for errors, try alternative endpoint
      return await fetchWITSAlternative(reporterIso, partnerIso, productCode, tradeYear);
    }

    const json = (await res.json()) as Record<string, unknown>;
    return parseWITSResponse(json, reporterIso, partnerIso, productCode, tradeYear);
  } catch {
    // Fallback to the simpler WITS trade stats API
    return await fetchWITSAlternative(reporterIso, partnerIso, productCode, tradeYear);
  }
}

/**
 * Alternative WITS endpoint using their trade stats API.
 */
async function fetchWITSAlternative(
  reporter: string,
  partner: string,
  product: string,
  year: number
): Promise<WITSTradeRecord[]> {
  const url = `https://wits.worldbank.org/API/V1/wits/datasource/tradestats-trade/reporter/${reporter}/year/${year}/partner/${partner}/product/${product}/indicator/MPRT-TRD-VL?format=JSON`;

  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      console.warn(`[WITS] Alternative API also failed: ${res.status}`);
      return [];
    }

    const json = (await res.json()) as Record<string, unknown>;
    return parseWITSResponse(json, reporter, partner, product, year);
  } catch (err) {
    console.error(`[WITS] All endpoints failed:`, err);
    return [];
  }
}

function parseWITSResponse(
  json: Record<string, unknown>,
  reporter: string,
  partner: string,
  product: string,
  year: number
): WITSTradeRecord[] {
  // WITS response structure varies; extract what we can
  const datasets =
    (json.dataSets as Record<string, unknown>[]) ||
    (json.dataset as Record<string, unknown>[]) ||
    [];

  if (datasets.length === 0) {
    // Try to extract from flat structure
    const value = (json.value as number) || (json.Value as number);
    if (value) {
      return [
        {
          reporter,
          partner,
          productCode: product,
          productDescription: "",
          year,
          tradeFlow: "Import",
          tradeValue: value,
          indicator: "MPRT-TRD-VL",
          scrapedAt: new Date().toISOString(),
        },
      ];
    }
    return [];
  }

  return datasets.map((d) => ({
    reporter: (d.reporter as string) || reporter,
    partner: (d.partner as string) || partner,
    productCode: (d.productCode as string) || product,
    productDescription: (d.productDescription as string) || "",
    year: (d.year as number) || year,
    tradeFlow: ((d.tradeFlow as string) || "Import") as "Import" | "Export",
    tradeValue: (d.value as number) || (d.Value as number) || 0,
    indicator: (d.indicator as string) || "MPRT-TRD-VL",
    scrapedAt: new Date().toISOString(),
  }));
}

/**
 * Fetch trade data for multiple country-product pairs.
 */
export async function fetchWITSBatch(
  queries: {
    reporter: string;
    partner: string;
    productCode: string;
  }[],
  year?: number
): Promise<WITSTradeRecord[]> {
  const allRecords: WITSTradeRecord[] = [];

  for (const q of queries) {
    const records = await fetchWITSTrade(q.reporter, q.partner, q.productCode, year);
    allRecords.push(...records);
    await sleep(1500); // polite delay for World Bank API
  }

  console.log(`[WITS] Total: ${allRecords.length} records across ${queries.length} queries`);
  return allRecords;
}

/**
 * Pre-built queries for US import analysis from key trading partners.
 */
export const US_IMPORT_QUERIES = [
  { reporter: "USA", partner: "CHN", productCode: "85" },  // Electrical machinery
  { reporter: "USA", partner: "CHN", productCode: "84" },  // Machinery
  { reporter: "USA", partner: "VNM", productCode: "85" },  // Vietnam electronics
  { reporter: "USA", partner: "IND", productCode: "33" },  // India beauty/cosmetics
  { reporter: "USA", partner: "DEU", productCode: "84" },  // Germany machinery
  { reporter: "USA", partner: "KOR", productCode: "85" },  // Korea electronics
  { reporter: "USA", partner: "TWN", productCode: "85" },  // Taiwan semiconductors
  { reporter: "USA", partner: "MYS", productCode: "85" },  // Malaysia electronics
];
