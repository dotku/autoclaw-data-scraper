/**
 * sienovo-intl lead-generation tasks.
 *
 * Runs ONE independent collection task per customer segment, cleans the
 * results (dedupe + normalize), optionally enriches the top leads with
 * decision-maker contacts, and writes them into the enterprise resource
 * library at /resource-library/sienovo-intl/<segment>/.
 *
 * sienovo-intl sells edge-AI hardware (AI Box, RK3588 IoT gateway, edge
 * video analytics) to international markets, so segments and Apollo filters
 * target Western system integrators / distributors / end-users / OEMs.
 *
 * Usage:
 *   npx tsx src/leads/sienovo-intl.ts                 # all segments
 *   npx tsx src/leads/sienovo-intl.ts integrators     # one segment
 *   npx tsx src/leads/sienovo-intl.ts --no-enrich     # skip contact enrichment
 */
import { pathToFileURL } from "url";
import {
  searchCompanies,
  enrichCompany,
  findContacts,
  type CompanySearchFilters,
} from "../scrapers/apollo.js";
import { writeLeads, writeManifest } from "../storage/resource-library.js";
import { domainSearch } from "../scrapers/hunter.js";

export const CLIENT = "sienovo-intl";

interface Segment {
  key: string;
  label: string;
  search: CompanySearchFilters;
  /** decision-maker titles to look up when enriching */
  titles: string[];
}

// Western-market focus for the international arm.
const TARGET_LOCATIONS = [
  "United States",
  "Canada",
  "United Kingdom",
  "Germany",
  "Australia",
];

export const SEGMENTS: Segment[] = [
  {
    key: "system-integrators",
    label: "系统集成商 / 方案商",
    search: {
      keywordTags: [
        "video analytics",
        "video surveillance",
        "machine vision",
        "edge computing",
        "system integrator",
        "smart city",
      ],
      employeeRanges: ["11,50", "51,200", "201,500"],
      locations: TARGET_LOCATIONS,
    },
    titles: ["CEO", "Founder", "CTO", "VP Engineering", "Solutions Director", "Procurement"],
  },
  {
    key: "hardware-distributors",
    label: "硬件分销商 / 贸易商",
    search: {
      keywordTags: [
        "embedded computer",
        "industrial pc",
        "single board computer",
        "iot gateway",
        "electronics distributor",
        "embedded systems",
      ],
      employeeRanges: ["11,50", "51,200", "201,500"],
      locations: TARGET_LOCATIONS,
    },
    titles: ["CEO", "Owner", "Purchasing Manager", "Product Manager", "Business Development"],
  },
  {
    key: "end-users",
    label: "终端企业用户",
    search: {
      keywordTags: [
        "factory automation",
        "quality inspection",
        "retail analytics",
        "smart manufacturing",
        "industrial automation",
      ],
      employeeRanges: ["51,200", "201,500", "501,1000"],
      locations: TARGET_LOCATIONS,
    },
    titles: ["VP Operations", "Plant Manager", "Director of IT", "Innovation Manager", "CTO"],
  },
  {
    key: "oem-brands",
    label: "OEM / 品牌方",
    search: {
      keywordTags: [
        "oem electronics",
        "odm",
        "white label",
        "contract manufacturing",
        "product design",
      ],
      employeeRanges: ["11,50", "51,200", "201,500"],
      locations: TARGET_LOCATIONS,
    },
    titles: ["CEO", "Founder", "Head of Product", "Sourcing Manager", "Engineering Director"],
  },
];

// How many search pages per segment, and how many top leads to enrich.
const PAGES_PER_SEGMENT = 2;
const PER_PAGE = 25;
const ENRICH_TOP_N = 8;

// Hunter email resolution: Apollo masks emails, so we use Hunter domain-search
// to get verified decision-maker emails. Capped per run to protect the credit
// budget (free tier is small; ~1 credit per domain, returns several emails).
const HUNTER_MAX_LOOKUPS = Number(process.env.HUNTER_MAX_LOOKUPS ?? 15);
const HUNTER_MIN_CONFIDENCE = 90; // only keep high-confidence (deliverable) emails

interface Lead {
  name: string;
  domain: string;
  linkedinUrl: string;
  apolloId: string;
  // filled in during enrichment (top N only):
  industry?: string;
  employeeCount?: number;
  estimatedRevenue?: string;
  country?: string;
  description?: string;
  contacts?: { name: string; title: string; email: string; linkedinUrl: string }[];
  source: string;
  collectedAt: string;
}

function normalizeDomain(d: string): string {
  return d.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "").trim();
}

/** Clean a raw search batch: drop no-domain rows, dedupe by domain, trim names. */
function clean(raw: { name: string; domain: string; linkedinUrl: string; apolloId: string }[]): Lead[] {
  const seen = new Set<string>();
  const out: Lead[] = [];
  const now = new Date().toISOString();
  for (const r of raw) {
    const domain = normalizeDomain(r.domain);
    const name = r.name.trim();
    if (!domain || !name) continue;
    if (seen.has(domain)) continue;
    seen.add(domain);
    out.push({
      name,
      domain,
      linkedinUrl: r.linkedinUrl || "",
      apolloId: r.apolloId || "",
      source: "apollo:search",
      collectedAt: now,
    });
  }
  return out;
}

function toCSV(leads: Lead[]): string {
  const cols = [
    "name", "domain", "industry", "employeeCount", "estimatedRevenue", "country",
    "linkedinUrl", "contactName", "contactTitle", "contactEmail",
  ];
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = leads.map((l) => {
    const c = l.contacts?.[0];
    return [
      l.name, l.domain, l.industry, l.employeeCount, l.estimatedRevenue, l.country,
      l.linkedinUrl, c?.name, c?.title, c?.email,
    ].map(esc).join(",");
  });
  return [cols.join(","), ...rows].join("\n");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runSegment(seg: Segment, enrich: boolean, today: string, hunterBudget: { remaining: number }) {
  console.log(`\n=== Task: ${seg.key} (${seg.label}) ===`);
  const raw: { name: string; domain: string; linkedinUrl: string; apolloId: string }[] = [];
  for (let page = 1; page <= PAGES_PER_SEGMENT; page++) {
    const batch = await searchCompanies({ ...seg.search, page, perPage: PER_PAGE });
    console.log(`  page ${page}: ${batch.length} companies`);
    raw.push(...batch);
    await sleep(1000);
    if (batch.length < PER_PAGE) break;
  }

  const leads = clean(raw);
  console.log(`  cleaned: ${leads.length} unique companies (from ${raw.length} raw)`);

  if (enrich) {
    const top = leads.slice(0, ENRICH_TOP_N);
    console.log(`  enriching top ${top.length} with firmographics + contacts...`);
    for (const lead of top) {
      const org = await enrichCompany(lead.name, lead.domain);
      if (org) {
        lead.industry = org.industry;
        lead.employeeCount = org.employeeCount;
        lead.estimatedRevenue = org.estimatedRevenue;
        lead.country = org.country;
        lead.description = org.description;
      }
      // Apollo finds the right people but masks emails — keep as fallback.
      lead.contacts = (await findContacts(lead.name, seg.titles, 3)).map((c) => ({
        name: `${c.firstName} ${c.lastName}`.trim(),
        title: c.title,
        email: c.email,
        linkedinUrl: c.linkedinUrl,
      }));

      // Resolve VERIFIED emails via Hunter (budget-capped to protect credits).
      if (process.env.HUNTER_API_KEY && lead.domain && hunterBudget.remaining > 0) {
        hunterBudget.remaining--;
        const hits = (await domainSearch(lead.domain, { limit: 6 })).filter(
          (e) => e.email && e.confidence >= HUNTER_MIN_CONFIDENCE
        );
        if (hits.length) {
          lead.contacts = hits.slice(0, 4).map((e) => ({
            name: `${e.firstName} ${e.lastName}`.trim(),
            title: e.position || "",
            email: e.email,
            linkedinUrl: e.linkedin || "",
          }));
          console.log(`    ✉ ${lead.domain}: ${hits.length} verified emails (Hunter, ${hunterBudget.remaining} lookups left)`);
        }
      }
      await sleep(1200);
    }
  }

  // Never clobber existing data with an empty result — a 0-lead outcome almost
  // always means an upstream failure (e.g. Apollo out of credits / rate-limit),
  // not that the segment is genuinely empty. Skip the write and signal it.
  if (leads.length === 0) {
    console.warn(`  ⚠️  0 leads for ${seg.key} — likely an API error; skipping write to avoid clobbering existing data.`);
    return { key: seg.key, label: seg.label, total: 0, enriched: 0, skipped: true };
  }

  // Write to enterprise resource library (local fs or S3 — see writer)
  const res = await writeLeads(CLIENT, seg.key, today, JSON.stringify(leads, null, 2), toCSV(leads));
  console.log(`  ✅ [${res.backend}] ${res.jsonPath}`);

  return { key: seg.key, label: seg.label, total: leads.length, enriched: enrich ? Math.min(ENRICH_TOP_N, leads.length) : 0 };
}

/** Importable entry point — used by both the CLI and the AWS Lambda handler. */
export async function runLeadTasks(opts: { only?: string; enrich?: boolean; today: string }) {
  const enrich = opts.enrich ?? true;
  const segments = opts.only
    ? SEGMENTS.filter((s) => s.key === opts.only || s.key.startsWith(opts.only!))
    : SEGMENTS;
  if (segments.length === 0) throw new Error(`No segment matches "${opts.only}"`);

  // Shared across segments so one run never exceeds the Hunter credit cap.
  const hunterBudget = { remaining: enrich ? HUNTER_MAX_LOOKUPS : 0 };
  const summary = [];
  for (const seg of segments) summary.push(await runSegment(seg, enrich, opts.today, hunterBudget));

  const manifest = { client: CLIENT, generatedAt: new Date().toISOString(), segments: summary };
  await writeManifest(CLIENT, opts.today, manifest);
  return summary;
}

async function main() {
  if (!process.env.APOLLO_API_KEY) {
    console.error("APOLLO_API_KEY is required (set in .env.local and `source` it).");
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const enrich = !args.includes("--no-enrich");
  const only = args.find((a) => !a.startsWith("--"));
  const today = new Date().toISOString().split("T")[0];
  console.log(`AutoClaw lead tasks for ${CLIENT} — ${today} (enrich: ${enrich})`);

  const summary = await runLeadTasks({ only, enrich, today });

  console.log("\n=== Summary ===");
  for (const s of summary) console.log(`  ${s.key.padEnd(22)} ${s.total} leads (${s.enriched} enriched)`);
}

// Only run the CLI when invoked directly (`tsx src/leads/sienovo-intl.ts`),
// NOT when imported — e.g. the Lambda bundle imports runLeadTasks/CLIENT and
// must not trigger main()/process.exit() at module load.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
