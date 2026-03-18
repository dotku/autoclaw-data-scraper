/**
 * Build outreach targets from scraped + enriched data.
 * Merges data from ImportYeti, Apollo, LinkedIn, OEC, WITS
 * into unified OutreachTarget objects.
 */

import type { ImportRecord } from "../scrapers/importyeti.js";
import type { EnrichedCompanyData } from "../scrapers/apollo.js";
import type { LinkedInCompany, LinkedInPerson } from "../scrapers/linkedin.js";
import type { OECTradeFlow } from "../scrapers/oec.js";
import type { OutreachTarget } from "./email-generator.js";

interface MergedData {
  importRecords?: ImportRecord[];
  enrichedData?: EnrichedCompanyData[];
  linkedInCompanies?: LinkedInCompany[];
  linkedInPeople?: LinkedInPerson[];
  tradeFlows?: OECTradeFlow[];
}

/**
 * Build outreach targets by merging all available data sources.
 * Deduplicates by company name and picks the best contact for each.
 */
export function buildOutreachTargets(data: MergedData): OutreachTarget[] {
  const targetMap = new Map<string, OutreachTarget>();

  // 1. Start with ImportYeti records as base
  if (data.importRecords) {
    for (const record of data.importRecords) {
      const key = normalizeCompanyName(record.companyName);
      targetMap.set(key, {
        companyName: record.companyName,
        country: record.country,
        productDescription: record.productDescription,
        supplierCount: record.suppliers.length,
      });
    }
  }

  // 2. Enrich with Apollo data
  if (data.enrichedData) {
    for (const enriched of data.enrichedData) {
      const companyName =
        (enriched.original.companyName as string) ||
        enriched.apollo?.name ||
        "";
      if (!companyName) continue;

      const key = normalizeCompanyName(companyName);
      const existing = targetMap.get(key) || { companyName };

      if (enriched.apollo) {
        existing.industry = enriched.apollo.industry || existing.industry;
        existing.country = enriched.apollo.country || existing.country;
        existing.employeeCount =
          enriched.apollo.employeeCount || existing.employeeCount;
        existing.linkedinUrl =
          enriched.apollo.linkedinUrl || existing.linkedinUrl;
        existing.productDescription =
          enriched.apollo.description || existing.productDescription;
      }

      // Pick the best contact (highest seniority)
      if (enriched.contacts.length > 0) {
        const bestContact = pickBestContact(enriched.contacts);
        existing.contactName = `${bestContact.firstName} ${bestContact.lastName}`.trim();
        existing.contactTitle = bestContact.title;
        existing.contactEmail = bestContact.email;
        if (!existing.linkedinUrl && bestContact.linkedinUrl) {
          existing.linkedinUrl = bestContact.linkedinUrl;
        }
      }

      targetMap.set(key, existing);
    }
  }

  // 3. Merge LinkedIn data
  if (data.linkedInCompanies) {
    for (const li of data.linkedInCompanies) {
      const key = normalizeCompanyName(li.name);
      const existing = targetMap.get(key) || { companyName: li.name };
      existing.linkedinUrl = li.linkedinUrl || existing.linkedinUrl;
      existing.industry = li.industry || existing.industry;
      existing.employeeCount = li.employeeCount || existing.employeeCount;
      targetMap.set(key, existing);
    }
  }

  if (data.linkedInPeople) {
    for (const person of data.linkedInPeople) {
      const key = normalizeCompanyName(person.company);
      const existing = targetMap.get(key);
      if (existing && !existing.contactName) {
        existing.contactName = person.name;
        existing.contactTitle = person.title;
      }
    }
  }

  // 4. Attach trade value from OEC data (aggregate by country match)
  if (data.tradeFlows) {
    const countryTradeMap = new Map<string, number>();
    for (const flow of data.tradeFlows) {
      const country = flow.exporterCountry.toLowerCase();
      countryTradeMap.set(
        country,
        (countryTradeMap.get(country) || 0) + flow.tradeValue
      );
    }

    for (const target of targetMap.values()) {
      if (target.country) {
        const countryKey = target.country.toLowerCase();
        const tradeVal = countryTradeMap.get(countryKey);
        if (tradeVal) {
          target.tradeValue = tradeVal;
        }
      }
    }
  }

  // Filter out targets with no useful data
  const targets = [...targetMap.values()].filter(
    (t) => t.companyName && t.companyName.length > 1
  );

  // Sort by data completeness (targets with email first, then with contacts)
  targets.sort((a, b) => {
    const scoreA = (a.contactEmail ? 4 : 0) + (a.contactName ? 2 : 0) + (a.industry ? 1 : 0);
    const scoreB = (b.contactEmail ? 4 : 0) + (b.contactName ? 2 : 0) + (b.industry ? 1 : 0);
    return scoreB - scoreA;
  });

  return targets;
}

function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const SENIORITY_ORDER = [
  "ceo", "founder", "owner", "president", "coo", "cfo",
  "vp", "vice president", "director", "head", "manager",
];

function pickBestContact(
  contacts: { firstName: string; lastName: string; title: string; email: string; linkedinUrl: string }[]
): typeof contacts[0] {
  // Sort by seniority
  return contacts.sort((a, b) => {
    const aIdx = SENIORITY_ORDER.findIndex((s) =>
      a.title.toLowerCase().includes(s)
    );
    const bIdx = SENIORITY_ORDER.findIndex((s) =>
      b.title.toLowerCase().includes(s)
    );
    const aScore = aIdx === -1 ? 999 : aIdx;
    const bScore = bIdx === -1 ? 999 : bIdx;
    // Prefer contacts with email
    if (a.email && !b.email) return -1;
    if (!a.email && b.email) return 1;
    return aScore - bScore;
  })[0];
}
