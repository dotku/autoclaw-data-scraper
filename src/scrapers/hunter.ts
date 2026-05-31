/**
 * Hunter.io — find & verify email addresses for a company domain.
 *
 * Used to BACKFILL the verified emails that Apollo masks on the free/API tier.
 * Feed it a domain (which we already have from Apollo / Places), get back
 * decision-maker emails with confidence scores.
 *
 * API: https://api.hunter.io/v2/domain-search  (GET)
 * Free tier: 25 searches/mo + 50 verifications/mo; paid plans scale up.
 *
 * Requires HUNTER_API_KEY (https://hunter.io/api-keys).
 */

const HUNTER_BASE = "https://api.hunter.io/v2";

export interface HunterEmail {
  email: string;
  firstName: string;
  lastName: string;
  position: string;
  department: string;
  confidence: number; // 0-100
  linkedin: string;
}

function getApiKey(): string {
  const key = process.env.HUNTER_API_KEY;
  if (!key) throw new Error("HUNTER_API_KEY environment variable is required");
  return key;
}

/**
 * Return emails found for a domain, highest-confidence first.
 * `seniority` limits to senior/executive contacts when supported.
 */
export async function domainSearch(
  domain: string,
  opts: { limit?: number; department?: string } = {}
): Promise<HunterEmail[]> {
  const { limit = 5, department } = opts;
  const params = new URLSearchParams({
    domain,
    limit: String(limit),
    api_key: getApiKey(),
  });
  if (department) params.set("department", department);

  try {
    const res = await fetch(`${HUNTER_BASE}/domain-search?${params}`);
    if (!res.ok) {
      console.warn(`[Hunter] ${res.status} for ${domain}: ${(await res.text()).slice(0, 160)}`);
      return [];
    }
    const data = (await res.json()) as { data?: { emails?: Record<string, any>[] } };
    const emails = data.data?.emails || [];
    return emails
      .map((e) => ({
        email: e.value || "",
        firstName: e.first_name || "",
        lastName: e.last_name || "",
        position: e.position || "",
        department: e.department || "",
        confidence: e.confidence || 0,
        linkedin: e.linkedin || "",
      }))
      .sort((a, b) => b.confidence - a.confidence);
  } catch (err) {
    console.warn(`[Hunter] domain-search failed for ${domain}:`, err);
    return [];
  }
}
