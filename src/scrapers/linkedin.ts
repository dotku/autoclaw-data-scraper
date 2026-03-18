/**
 * LinkedIn public data scraper.
 * Uses LinkedIn's public "Voyager" API endpoints that don't require OAuth.
 * Only scrapes publicly available company/people data.
 *
 * Note: LinkedIn aggressively rate-limits. Use conservatively.
 * For production, consider LinkedIn Marketing API (free tier available).
 */

import { fetchPage, sleep } from "../utils/http.js";

export interface LinkedInCompany {
  name: string;
  universalName: string;
  description: string;
  industry: string;
  employeeCount: string;
  headquarters: string;
  website: string;
  specialties: string[];
  linkedinUrl: string;
  scrapedAt: string;
}

export interface LinkedInPerson {
  name: string;
  title: string;
  company: string;
  location: string;
  linkedinUrl: string;
  scrapedAt: string;
}

/**
 * Scrape public LinkedIn company page data using Google cached/indexed pages.
 * This avoids hitting LinkedIn directly and respects their ToS better.
 */
export async function scrapeLinkedInCompany(
  companyName: string
): Promise<LinkedInCompany | null> {
  console.log(`[LinkedIn] Looking up company: "${companyName}"`);

  try {
    // Use Google search to find the LinkedIn page
    const searchUrl = `https://www.google.com/search?q=site:linkedin.com/company+"${encodeURIComponent(companyName)}"`;
    const $ = await fetchPage(searchUrl);

    // Extract LinkedIn URL from Google results
    let linkedinUrl = "";
    $("a[href*='linkedin.com/company/']").each((_, el) => {
      const href = $(el).attr("href") || "";
      const match = href.match(/linkedin\.com\/company\/[^/&?]+/);
      if (match && !linkedinUrl) {
        linkedinUrl = `https://www.${match[0]}`;
      }
    });

    if (!linkedinUrl) {
      console.warn(`[LinkedIn] No company page found for "${companyName}"`);
      return null;
    }

    // Extract info from Google snippet
    const snippet = $(".VwiC3b, .s3v9rd, .IsZvec").first().text().trim();
    const titleText = $("h3").first().text().trim();

    // Parse employee count from snippet (LinkedIn often shows this)
    const empMatch = snippet.match(/(\d[\d,]+)\s*(?:employees|followers)/i);
    const employeeCount = empMatch ? empMatch[1] : "";

    return {
      name: companyName,
      universalName: linkedinUrl.split("/company/")[1]?.replace(/\/$/, "") || "",
      description: snippet.slice(0, 500),
      industry: extractIndustry(snippet + " " + titleText),
      employeeCount,
      headquarters: extractLocation(snippet),
      website: "",
      specialties: [],
      linkedinUrl,
      scrapedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.warn(`[LinkedIn] Failed for "${companyName}":`, err);
    return null;
  }
}

/**
 * Search for key decision makers at a company via Google + LinkedIn.
 */
export async function searchLinkedInPeople(
  companyName: string,
  roles: string[] = ["CEO", "Founder", "Owner", "Director of Sales", "VP Business Development"],
  maxResults = 5
): Promise<LinkedInPerson[]> {
  console.log(`[LinkedIn] Searching people at: "${companyName}"`);
  const people: LinkedInPerson[] = [];

  try {
    // Search Google for LinkedIn profiles at this company
    const roleQuery = roles.slice(0, 3).join(" OR ");
    const searchUrl = `https://www.google.com/search?q=site:linkedin.com/in+"${encodeURIComponent(companyName)}"+(${encodeURIComponent(roleQuery)})&num=${maxResults}`;

    const $ = await fetchPage(searchUrl);

    $("div.g, div.tF2Cxc").each((_, result) => {
      if (people.length >= maxResults) return;

      const link = $(result).find("a").first().attr("href") || "";
      if (!link.includes("linkedin.com/in/")) return;

      const title = $(result).find("h3").first().text().trim();
      const snippet = $(result).find(".VwiC3b, .s3v9rd").first().text().trim();

      // Parse name and title from Google result
      const nameParts = title.split(" - ");
      const name = nameParts[0]?.trim() || "";
      const personTitle = nameParts[1]?.trim() || extractTitle(snippet, roles);

      if (name) {
        people.push({
          name,
          title: personTitle,
          company: companyName,
          location: extractLocation(snippet),
          linkedinUrl: link.startsWith("http") ? link : `https://${link}`,
          scrapedAt: new Date().toISOString(),
        });
      }
    });

    console.log(`[LinkedIn] Found ${people.length} people at "${companyName}"`);
  } catch (err) {
    console.warn(`[LinkedIn] People search failed for "${companyName}":`, err);
  }

  return people;
}

/**
 * Batch lookup companies and their key people.
 */
export async function linkedInBatchLookup(
  companyNames: string[],
  options: { findPeople?: boolean; delayMs?: number } = {}
): Promise<{ companies: LinkedInCompany[]; people: LinkedInPerson[] }> {
  const { findPeople = true, delayMs = 3000 } = options;
  const companies: LinkedInCompany[] = [];
  const people: LinkedInPerson[] = [];

  for (const name of companyNames) {
    const company = await scrapeLinkedInCompany(name);
    if (company) companies.push(company);
    await sleep(delayMs);

    if (findPeople) {
      const contacts = await searchLinkedInPeople(name);
      people.push(...contacts);
      await sleep(delayMs);
    }
  }

  return { companies, people };
}

// --- Helpers ---

function extractIndustry(text: string): string {
  const industries = [
    "Technology", "Manufacturing", "Electronics", "Retail", "Wholesale",
    "Import/Export", "Trading", "Logistics", "Consumer Goods", "Beauty",
    "Automotive", "Healthcare", "Energy", "Construction", "Agriculture",
    "Telecommunications", "Financial Services", "Real Estate",
  ];
  for (const ind of industries) {
    if (text.toLowerCase().includes(ind.toLowerCase())) return ind;
  }
  return "";
}

function extractLocation(text: string): string {
  const locMatch = text.match(
    /(?:based in|located in|headquarters?(?:\s+in)?|,\s*)([A-Z][a-zA-Z\s]+,\s*[A-Z]{2})/
  );
  return locMatch ? locMatch[1].trim() : "";
}

function extractTitle(text: string, roles: string[]): string {
  for (const role of roles) {
    if (text.toLowerCase().includes(role.toLowerCase())) return role;
  }
  return "";
}
