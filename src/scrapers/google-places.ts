/**
 * Google Places API (New, v1) — company discovery by location + keyword.
 *
 * Best lead source for LOCAL system integrators / installers worldwide that
 * Apollo misses (regional CCTV installers, automation shops, etc.). Query by
 * "<keyword> in <city>" and get name + website + address + rating.
 *
 * API: https://places.googleapis.com/v1/places:searchText  (POST)
 * Auth: X-Goog-Api-Key header. Pricing: Text Search ~$32/1k requests, but the
 * free tier covers $200/mo of usage — plenty for periodic prospecting.
 *
 * Requires GOOGLE_PLACES_API_KEY (enable "Places API (New)" in Google Cloud).
 */

const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";

// Only the fields we need — FieldMask keeps the bill in the cheap tier.
const FIELD_MASK = [
  "places.displayName",
  "places.websiteUri",
  "places.formattedAddress",
  "places.internationalPhoneNumber",
  "places.rating",
  "places.businessStatus",
  "nextPageToken",
].join(",");

export interface PlaceLead {
  name: string;
  website: string;
  address: string;
  phone: string;
  rating: number;
  source: string;
  scrapedAt: string;
}

function getApiKey(): string {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) throw new Error("GOOGLE_PLACES_API_KEY environment variable is required");
  return key;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run one text query (e.g. "security system integrator in Berlin"), following
 * pagination up to `maxPages` (Google returns ~20 results/page).
 */
export async function searchPlaces(
  textQuery: string,
  maxPages = 2
): Promise<PlaceLead[]> {
  const out: PlaceLead[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const body: Record<string, unknown> = { textQuery };
    if (pageToken) body.pageToken = pageToken;

    const res = await fetch(PLACES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": getApiKey(),
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.warn(`[Places] ${res.status}: ${(await res.text()).slice(0, 200)}`);
      break;
    }

    const data = (await res.json()) as {
      places?: Record<string, any>[];
      nextPageToken?: string;
    };
    const now = new Date().toISOString();
    for (const p of data.places || []) {
      out.push({
        name: p.displayName?.text || "",
        website: p.websiteUri || "",
        address: p.formattedAddress || "",
        phone: p.internationalPhoneNumber || "",
        rating: p.rating || 0,
        source: "google-places",
        scrapedAt: now,
      });
    }

    pageToken = data.nextPageToken;
    if (!pageToken) break;
    await sleep(2000); // nextPageToken needs a short delay before it's valid
  }

  return out;
}

/**
 * Fan out one keyword across many cities — the practical way to build a
 * worldwide list of local integrators/installers.
 */
export async function searchPlacesBatch(
  keywords: string[],
  cities: string[],
  maxPagesPerQuery = 1
): Promise<PlaceLead[]> {
  const all: PlaceLead[] = [];
  for (const kw of keywords) {
    for (const city of cities) {
      const q = `${kw} in ${city}`;
      console.log(`[Places] "${q}"`);
      try {
        all.push(...(await searchPlaces(q, maxPagesPerQuery)));
      } catch (err) {
        console.warn(`[Places] query failed "${q}":`, err);
      }
      await sleep(500);
    }
  }
  return all;
}
