# AutoClaw Data Scraper

Daily trade intelligence scraper powered by GitHub Actions.

## What it does

1. **Scrapes ImportYeti** — US customs import/export records (companies, suppliers, HS codes, shipments)
2. **Enriches with Apollo** — Firmographic data, contacts, revenue, tech stack
3. **Analyzes with Gemini** — AI-powered trade trend analysis and recommendations

## Architecture

```
GitHub Actions (daily cron)
  → ImportYeti Scraper (Cheerio or Playwright)
  → Apollo API Enrichment
  → Google Gemini Analysis
  → Data saved to /data + uploaded as artifact
```

Full architecture docs live in [`docs/`](docs/):

- [Current architecture (As-Is)](docs/architecture-current.md) — how the system runs today
- [Architecture design (To-Be)](docs/architecture-design.md) — enterprise-grade target + roadmap

## Setup

### 1. Install dependencies

```bash
cd autoclaw-data-scraper
npm install
npx playwright install chromium  # only if using Playwright mode
```

### 2. Set environment variables

```bash
# Required for LLM analysis (free tier: 15 RPM)
export GEMINI_API_KEY=your_gemini_api_key

# Required for enrichment (free tier: 10k credits/mo)
export APOLLO_API_KEY=your_apollo_api_key
```

### 3. Run locally

```bash
# Lightweight mode (Cheerio)
npm run scrape

# With Playwright (handles JS-rendered pages)
npm run scrape:playwright

# Dry run (no actual scraping)
npm test
```

### 4. GitHub Actions setup

Add these secrets to your repo (`Settings > Secrets > Actions`):

| Secret | Required | Description |
|--------|----------|-------------|
| `GEMINI_API_KEY` | Optional | Google Gemini API key (free at aistudio.google.com) |
| `APOLLO_API_KEY` | Optional | Apollo.io API key (free tier available) |

The workflow runs daily at 6:00 AM UTC. You can also trigger it manually from the Actions tab.

## CLI Flags

| Flag | Description |
|------|-------------|
| `--use-playwright` | Use Playwright instead of Cheerio |
| `--skip-enrich` | Skip Apollo enrichment |
| `--skip-llm` | Skip Gemini analysis |
| `--dry-run` | Preview what would happen |
| `--source importyeti` | Only run ImportYeti scraper |

## Customization

Edit `SEARCH_KEYWORDS` in [src/main.ts](src/main.ts) to target different product categories or companies.

## Output

Data is saved to the `data/` directory:

- `importyeti-YYYY-MM-DD.json` — Raw scraped records
- `enriched-YYYY-MM-DD.json` — Apollo-enriched data
- `analysis-YYYY-MM-DD.json` — Gemini AI analysis

## Free Tier Limits

| Service | Free Tier |
|---------|-----------|
| Google Gemini | 15 RPM, 1M TPM |
| Apollo.io | 10,000 credits/month |
| GitHub Actions | 2,000 min/month (public repos unlimited) |
