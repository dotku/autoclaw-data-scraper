/**
 * Firecrawl content-signal scraper — our (free-tier) substitute for paid
 * technographic APIs (BuiltWith/Wappalyzer). Scrapes a company's site and
 * detects edge-AI / industrial-computing domain signals, producing an ICP
 * **fit score** + the matched signals. Triple duty (see architecture-design
 * Part III §19): technographic signal, ICP scoring input, and email
 * personalization material.
 *
 * REST API: POST https://api.firecrawl.dev/v1/scrape  (Authorization: Bearer)
 * Requires FIRECRAWL_API_KEY. 1 scrape ≈ 1 credit.
 */

const FIRECRAWL_URL = "https://api.firecrawl.dev/v1/scrape";

// ICP-relevant signals for sienovo-intl (edge-AI hardware). Presence of these
// on a prospect's site = stronger fit. Lowercased; matched as substrings.
export const ICP_SIGNALS = [
  "edge ai", "edge computing", "video analytics", "machine vision", "computer vision",
  "object detection", "rk3588", "jetson", "npu", "inference", "ai box",
  "nvr", "vms", "surveillance", "cctv", "onvif", "rtsp",
  "iot gateway", "embedded", "industrial pc", "single board computer", "soc",
  "smart city", "smart retail", "people counting", "license plate", "anpr",
  "ai accelerator", "on-prem", "real-time analytics",
];

export interface FirecrawlSignals {
  scraped: boolean;
  matched: string[]; // ICP signals found on the site
  fitScore: number; // 0-100 (signal density)
}

function getApiKey(): string {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) throw new Error("FIRECRAWL_API_KEY environment variable is required");
  return key;
}

/**
 * Scrape a domain's homepage and score it against the ICP signal set.
 * Failures (timeouts, blocked) return scraped:false, fitScore:0 — never throw,
 * so a single bad site doesn't break the run.
 */
export async function scrapeSignals(
  domain: string,
  signals: string[] = ICP_SIGNALS
): Promise<FirecrawlSignals> {
  const url = domain.startsWith("http") ? domain : `https://${domain}`;
  try {
    const res = await fetch(FIRECRAWL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getApiKey()}`,
      },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true, timeout: 20000 }),
    });
    if (!res.ok) {
      console.warn(`[Firecrawl] ${res.status} for ${domain}: ${(await res.text()).slice(0, 140)}`);
      return { scraped: false, matched: [], fitScore: 0 };
    }
    const data = (await res.json()) as { data?: { markdown?: string } };
    const text = (data.data?.markdown || "").toLowerCase();
    if (!text) return { scraped: false, matched: [], fitScore: 0 };

    const matched = signals.filter((s) => text.includes(s));
    // Signal-density score: each match adds weight, capped at 100.
    const fitScore = Math.min(100, matched.length * 12);
    return { scraped: true, matched, fitScore };
  } catch (err) {
    console.warn(`[Firecrawl] scrape failed for ${domain}:`, (err as Error).message);
    return { scraped: false, matched: [], fitScore: 0 };
  }
}
