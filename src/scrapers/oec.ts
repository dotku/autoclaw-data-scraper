/**
 * Observatory of Economic Complexity (OEC) scraper.
 * OEC provides a public API for international trade data.
 * API: https://oec.world/api/
 *
 * Free, no API key required. Rate limit: be polite (~1 req/sec).
 */

import { sleep } from "../utils/http.js";

const OEC_API = "https://oec.world/olap-proxy/data.jsonrecords";

export interface OECTradeFlow {
  year: number;
  hsCode: string;
  hsDescription: string;
  exporterCountry: string;
  exporterCountryId: string;
  importerCountry: string;
  importerCountryId: string;
  tradeValue: number;
  quantity: number;
  unit: string;
  scrapedAt: string;
}

/**
 * Fetch bilateral trade flows for a given product (HS code) and year.
 * Uses OEC's OLAP proxy API.
 *
 * @param hsCode - HS 4-digit product code (e.g., "8541" for LEDs)
 * @param year - Trade year (default: latest available)
 * @param exporterIso - Exporter country ISO3 (e.g., "chn" for China)
 * @param importerIso - Importer country ISO3 (e.g., "usa" for US)
 */
export async function fetchOECTradeFlows(
  hsCode: string,
  options: {
    year?: number;
    exporterIso?: string;
    importerIso?: string;
    limit?: number;
  } = {}
): Promise<OECTradeFlow[]> {
  const { year, exporterIso, importerIso, limit = 50 } = options;
  const tradeYear = year || new Date().getFullYear() - 1;

  // Build OEC OLAP query
  const cube = "trade_i_baci_a_92";
  const drilldowns = "Year,HS4,Exporter Country,Importer Country";
  const measures = "Trade Value";

  const params = new URLSearchParams({
    cube,
    drilldowns,
    measures,
    Year: String(tradeYear),
    "HS4": hsCode,
    limit: String(limit),
    order: "Trade Value",
    sort: "desc",
  });

  if (exporterIso) {
    params.set("Exporter Country", exporterIso);
  }
  if (importerIso) {
    params.set("Importer Country", importerIso);
  }

  const url = `${OEC_API}?${params.toString()}`;
  console.log(`[OEC] Fetching trade flows for HS${hsCode} (${tradeYear})`);

  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      throw new Error(`OEC API ${res.status}: ${res.statusText}`);
    }

    const json = (await res.json()) as { data: Record<string, unknown>[] };
    const records = json.data || [];

    return records.map((r) => ({
      year: (r["Year"] as number) || tradeYear,
      hsCode: (r["HS4 ID"] as string) || hsCode,
      hsDescription: (r["HS4"] as string) || "",
      exporterCountry: (r["Exporter Country"] as string) || "",
      exporterCountryId: (r["Exporter Country ID"] as string) || "",
      importerCountry: (r["Importer Country"] as string) || "",
      importerCountryId: (r["Importer Country ID"] as string) || "",
      tradeValue: (r["Trade Value"] as number) || 0,
      quantity: (r["Quantity"] as number) || 0,
      unit: (r["Unit"] as string) || "",
      scrapedAt: new Date().toISOString(),
    }));
  } catch (err) {
    console.error(`[OEC] Failed for HS${hsCode}:`, err);
    return [];
  }
}

/**
 * Fetch trade data for multiple HS codes.
 */
export async function fetchOECBatch(
  hsCodes: string[],
  options: {
    year?: number;
    exporterIso?: string;
    importerIso?: string;
  } = {}
): Promise<OECTradeFlow[]> {
  const allFlows: OECTradeFlow[] = [];

  for (const hs of hsCodes) {
    const flows = await fetchOECTradeFlows(hs, options);
    allFlows.push(...flows);
    await sleep(1200);
  }

  console.log(`[OEC] Total: ${allFlows.length} trade flows across ${hsCodes.length} HS codes`);
  return allFlows;
}

/**
 * Common HS codes for trade intelligence.
 * Customize based on your target industry.
 */
export const COMMON_HS_CODES: Record<string, string> = {
  "8541": "Semiconductor devices; LEDs",
  "8504": "Electrical transformers, power supplies",
  "8471": "Computers and computing machines",
  "3304": "Beauty/cosmetics preparations",
  "8516": "Electric heaters, kitchen appliances",
  "8507": "Electric accumulators (batteries)",
  "8501": "Electric motors and generators",
  "9405": "Lamps and lighting fittings",
  "8544": "Insulated wire, cable, optical fiber",
  "7326": "Iron/steel articles",
};
