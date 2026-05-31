/**
 * Apollo.io API integration for company/contact enrichment.
 * Free tier: 10,000 credits/month, includes company & people search.
 * API docs: https://apolloio.github.io/apollo-api-docs/
 */

const APOLLO_BASE_URL = "https://api.apollo.io/v1";

export interface ApolloCompany {
  id: string;
  name: string;
  domain: string;
  industry: string;
  employeeCount: number;
  estimatedRevenue: string;
  city: string;
  state: string;
  country: string;
  linkedinUrl: string;
  description: string;
  technologies: string[];
  keywords: string[];
}

export interface ApolloContact {
  id: string;
  firstName: string;
  lastName: string;
  title: string;
  email: string;
  phone: string;
  company: string;
  linkedinUrl: string;
}

export interface EnrichedCompanyData {
  original: Record<string, unknown>;
  apollo: ApolloCompany | null;
  contacts: ApolloContact[];
  enrichedAt: string;
}

function getApiKey(): string {
  const key = process.env.APOLLO_API_KEY;
  if (!key) {
    throw new Error("APOLLO_API_KEY environment variable is required");
  }
  return key;
}

async function apolloFetch(
  endpoint: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const res = await fetch(`${APOLLO_BASE_URL}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "X-Api-Key": getApiKey(),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Apollo API ${res.status}: ${text}`);
  }

  return (await res.json()) as Record<string, unknown>;
}

/**
 * Search Apollo for a company by name and enrich with firmographic data.
 */
export async function enrichCompany(
  companyName: string,
  domain?: string
): Promise<ApolloCompany | null> {
  try {
    const data = await apolloFetch("/organizations/enrich", {
      domain: domain || null,
      name: companyName,
    });

    const org = data.organization as Record<string, unknown> | undefined;
    if (!org) return null;

    return {
      id: (org.id as string) || "",
      name: (org.name as string) || companyName,
      domain: (org.primary_domain as string) || "",
      industry: (org.industry as string) || "",
      employeeCount: (org.estimated_num_employees as number) || 0,
      estimatedRevenue: (org.annual_revenue_printed as string) || "",
      city: (org.city as string) || "",
      state: (org.state as string) || "",
      country: (org.country as string) || "",
      linkedinUrl: (org.linkedin_url as string) || "",
      description: (org.short_description as string) || "",
      technologies: (org.current_technologies as string[]) || [],
      keywords: (org.keywords as string[]) || [],
    };
  } catch (err) {
    console.warn(`[Apollo] Failed to enrich company "${companyName}":`, err);
    return null;
  }
}

/**
 * Search Apollo for companies matching an ICP (keywords + size + location).
 * This is the lead-discovery entry point: finds NEW companies from scratch,
 * unlike enrichCompany() which looks up a company you already know by name.
 *
 * Apollo's search results are lightweight (name + domain); full firmographics
 * come from a follow-up enrichCompany() call (which costs more credits).
 */
export interface CompanySearchFilters {
  keywordTags?: string[]; // q_organization_keyword_tags
  employeeRanges?: string[]; // e.g. ["11,50","51,200"]
  locations?: string[]; // e.g. ["United States","Germany"]
  page?: number;
  perPage?: number;
}

export async function searchCompanies(
  filters: CompanySearchFilters
): Promise<{ name: string; domain: string; linkedinUrl: string; apolloId: string }[]> {
  const body: Record<string, unknown> = {
    page: filters.page ?? 1,
    per_page: filters.perPage ?? 25,
  };
  if (filters.keywordTags?.length) body.q_organization_keyword_tags = filters.keywordTags;
  if (filters.employeeRanges?.length)
    body.organization_num_employees_ranges = filters.employeeRanges;
  if (filters.locations?.length) body.organization_locations = filters.locations;

  try {
    const data = await apolloFetch("/mixed_companies/search", body);
    const orgs = (data.organizations as Record<string, unknown>[]) || [];
    return orgs.map((o) => ({
      name: (o.name as string) || "",
      domain: (o.primary_domain as string) || ((o.website_url as string) || ""),
      linkedinUrl: (o.linkedin_url as string) || "",
      apolloId: (o.id as string) || "",
    }));
  } catch (err) {
    console.warn("[Apollo] Company search failed:", err);
    return [];
  }
}

/**
 * Search for key contacts (decision makers) at a company.
 */
export async function findContacts(
  companyName: string,
  titles: string[] = ["CEO", "Owner", "Founder", "Director", "VP", "Manager"],
  maxResults = 5
): Promise<ApolloContact[]> {
  try {
    const data = await apolloFetch("/mixed_people/api_search", {
      q_organization_name: companyName,
      person_titles: titles,
      page: 1,
      per_page: maxResults,
    });

    const people = (data.people as Record<string, unknown>[]) || [];

    return people.map((p) => ({
      id: (p.id as string) || "",
      firstName: (p.first_name as string) || "",
      lastName: (p.last_name as string) || "",
      title: (p.title as string) || "",
      email: (p.email as string) || "",
      phone:
        (p.phone_number as string) ||
        ((p.phone_numbers as Record<string, unknown>[])?.[ 0]?.sanitized_number as string) ||
        "",
      company: (p.organization_name as string) || companyName,
      linkedinUrl: (p.linkedin_url as string) || "",
    }));
  } catch (err) {
    console.warn(
      `[Apollo] Failed to find contacts for "${companyName}":`,
      err
    );
    return [];
  }
}

/**
 * Enrich a batch of companies from scraper results.
 * Respects rate limits with delays between requests.
 */
export async function enrichBatch(
  companies: { companyName: string; [key: string]: unknown }[],
  options: { findContactsForEach?: boolean; delayMs?: number } = {}
): Promise<EnrichedCompanyData[]> {
  const { findContactsForEach = true, delayMs = 1000 } = options;
  const results: EnrichedCompanyData[] = [];

  for (const company of companies) {
    console.log(`[Apollo] Enriching: ${company.companyName}`);

    const apolloData = await enrichCompany(company.companyName);
    let contacts: ApolloContact[] = [];

    if (findContactsForEach) {
      contacts = await findContacts(company.companyName);
      await delay(delayMs);
    }

    results.push({
      original: company,
      apollo: apolloData,
      contacts,
      enrichedAt: new Date().toISOString(),
    });

    await delay(delayMs);
  }

  return results;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
