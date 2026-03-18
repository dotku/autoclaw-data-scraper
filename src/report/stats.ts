/**
 * Stats report generator.
 * Reads scraped data files and generates an HTML summary report.
 */

import fs from "fs/promises";
import path from "path";

interface ReportData {
  importyeti: unknown[];
  oec: unknown[];
  wits: unknown[];
  ecommerce: {
    shopify: unknown[];
    amazon: unknown[];
    temu: unknown[];
    walmart: unknown[];
  };
  linkedin: { companies: unknown[]; people: unknown[] };
  enriched: unknown[];
  outreach: unknown[];
  analysis: string;
}

async function loadJSON(dir: string, filename: string): Promise<unknown> {
  try {
    const data = await fs.readFile(path.join(dir, filename), "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export async function generateStatsReport(
  dataDir: string,
  date: string
): Promise<string> {
  const data: ReportData = {
    importyeti: ((await loadJSON(dataDir, `importyeti-${date}.json`)) as unknown[]) || [],
    oec: ((await loadJSON(dataDir, `oec-${date}.json`)) as unknown[]) || [],
    wits: ((await loadJSON(dataDir, `wits-${date}.json`)) as unknown[]) || [],
    ecommerce: ((await loadJSON(dataDir, `ecommerce-${date}.json`)) as ReportData["ecommerce"]) || {
      shopify: [], amazon: [], temu: [], walmart: [],
    },
    linkedin: ((await loadJSON(dataDir, `linkedin-${date}.json`)) as ReportData["linkedin"]) || {
      companies: [], people: [],
    },
    enriched: ((await loadJSON(dataDir, `enriched-${date}.json`)) as unknown[]) || [],
    outreach: ((await loadJSON(dataDir, `outreach-${date}.json`)) as unknown[]) || [],
    analysis: ((await loadJSON(dataDir, `analysis-${date}.json`)) as string) || "",
  };

  const totalRecords =
    data.importyeti.length +
    data.oec.length +
    data.wits.length +
    data.ecommerce.shopify.length +
    data.ecommerce.amazon.length +
    data.ecommerce.temu.length +
    data.ecommerce.walmart.length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AutoClaw Scraper Report - ${date}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; padding: 2rem; }
  .container { max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 2rem; margin-bottom: 0.5rem; color: #f8fafc; }
  .date { color: #94a3b8; margin-bottom: 2rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
  .card { background: #1e293b; border-radius: 12px; padding: 1.5rem; border: 1px solid #334155; }
  .card h3 { font-size: 0.85rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem; }
  .card .value { font-size: 2.5rem; font-weight: 700; color: #38bdf8; }
  .card .sub { font-size: 0.8rem; color: #64748b; margin-top: 0.25rem; }
  .section { background: #1e293b; border-radius: 12px; padding: 1.5rem; border: 1px solid #334155; margin-bottom: 1.5rem; }
  .section h2 { font-size: 1.2rem; margin-bottom: 1rem; color: #f8fafc; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 0.6rem 0.8rem; border-bottom: 1px solid #334155; font-size: 0.9rem; }
  th { color: #94a3b8; font-weight: 600; }
  .badge { display: inline-block; padding: 0.15rem 0.6rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 500; }
  .badge-blue { background: #1e3a5f; color: #38bdf8; }
  .badge-green { background: #14532d; color: #4ade80; }
  .badge-purple { background: #3b0764; color: #c084fc; }
  .badge-orange { background: #431407; color: #fb923c; }
  .progress-bar { background: #334155; border-radius: 4px; height: 8px; overflow: hidden; }
  .progress-fill { height: 100%; border-radius: 4px; background: linear-gradient(90deg, #38bdf8, #818cf8); }
  pre { background: #0f172a; padding: 1rem; border-radius: 8px; overflow-x: auto; font-size: 0.8rem; color: #94a3b8; }
</style>
</head>
<body>
<div class="container">
  <h1>AutoClaw Scraper Report</h1>
  <p class="date">${date} | Total records: ${totalRecords}</p>

  <div class="grid">
    <div class="card">
      <h3>ImportYeti</h3>
      <div class="value">${data.importyeti.length}</div>
      <div class="sub">Import records</div>
    </div>
    <div class="card">
      <h3>OEC Trade Flows</h3>
      <div class="value">${data.oec.length}</div>
      <div class="sub">Bilateral flows</div>
    </div>
    <div class="card">
      <h3>WITS World Bank</h3>
      <div class="value">${data.wits.length}</div>
      <div class="sub">Trade records</div>
    </div>
    <div class="card">
      <h3>Shopify</h3>
      <div class="value">${data.ecommerce.shopify.length}</div>
      <div class="sub">Stores found</div>
    </div>
    <div class="card">
      <h3>Amazon</h3>
      <div class="value">${data.ecommerce.amazon.length}</div>
      <div class="sub">Seller listings</div>
    </div>
    <div class="card">
      <h3>Temu</h3>
      <div class="value">${data.ecommerce.temu.length}</div>
      <div class="sub">Products</div>
    </div>
    <div class="card">
      <h3>Walmart</h3>
      <div class="value">${data.ecommerce.walmart.length}</div>
      <div class="sub">Seller listings</div>
    </div>
    <div class="card">
      <h3>LinkedIn</h3>
      <div class="value">${data.linkedin.companies.length}</div>
      <div class="sub">${data.linkedin.people.length} contacts</div>
    </div>
    <div class="card">
      <h3>Apollo Enriched</h3>
      <div class="value">${data.enriched.length}</div>
      <div class="sub">Companies</div>
    </div>
    <div class="card">
      <h3>Outreach Emails</h3>
      <div class="value">${data.outreach.length}</div>
      <div class="sub">Generated</div>
    </div>
  </div>

  ${renderImportYetiTable(data.importyeti)}
  ${renderOutreachTable(data.outreach)}
  ${data.analysis ? renderAnalysis(data.analysis) : ""}
</div>
</body>
</html>`;
}

function renderImportYetiTable(records: unknown[]): string {
  if (records.length === 0) return "";
  const rows = (records as Record<string, unknown>[]).slice(0, 20);
  return `<div class="section">
    <h2>ImportYeti Records (top 20)</h2>
    <table>
      <thead><tr><th>Company</th><th>Country</th><th>Product</th><th>HS Code</th><th>Suppliers</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td>${r.companyName || ""}</td>
        <td><span class="badge badge-blue">${r.country || ""}</span></td>
        <td>${String(r.productDescription || "").slice(0, 80)}</td>
        <td>${r.hsCode || ""}</td>
        <td>${(r.suppliers as string[])?.length || 0}</td>
      </tr>`).join("")}</tbody>
    </table>
  </div>`;
}

function renderOutreachTable(emails: unknown[]): string {
  if (emails.length === 0) return "";
  const rows = (emails as Record<string, unknown>[]).slice(0, 10);
  return `<div class="section">
    <h2>Generated Outreach Emails (top 10)</h2>
    <table>
      <thead><tr><th>Company</th><th>Contact</th><th>Subject</th><th>Language</th></tr></thead>
      <tbody>${rows.map((e) => `<tr>
        <td>${e.targetCompany || ""}</td>
        <td>${e.contactName || "—"}</td>
        <td>${String(e.subject || "").slice(0, 60)}</td>
        <td><span class="badge badge-green">${e.language || "en"}</span></td>
      </tr>`).join("")}</tbody>
    </table>
  </div>`;
}

function renderAnalysis(analysis: string): string {
  return `<div class="section">
    <h2>AI Analysis</h2>
    <pre>${typeof analysis === "string" ? analysis : JSON.stringify(analysis, null, 2)}</pre>
  </div>`;
}
