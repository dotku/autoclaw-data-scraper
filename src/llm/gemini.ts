import { GoogleGenerativeAI } from "@google/generative-ai";

let genAI: GoogleGenerativeAI | null = null;

function getClient(): GoogleGenerativeAI {
  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is required");
    }
    genAI = new GoogleGenerativeAI(apiKey);
  }
  return genAI;
}

/**
 * Analyze scraped trade data using Google Gemini (free tier: 15 RPM, 1M TPM).
 * Extracts insights like market trends, supplier patterns, etc.
 */
export async function analyzeTradeData(
  data: Record<string, unknown>[],
  prompt?: string
): Promise<string> {
  const client = getClient();
  const model = client.getGenerativeModel({ model: "gemini-2.0-flash" });

  const defaultPrompt = `You are a trade intelligence analyst. Analyze the following US import/export data and provide:

1. **Key Trends**: What products/categories are most imported?
2. **Top Suppliers**: Which suppliers appear most frequently?
3. **Geographic Patterns**: Which countries are the main sources?
4. **Business Insights**: Any notable patterns that could be valuable for sourcing decisions?
5. **Actionable Recommendations**: What should an importer/business owner do based on this data?

Keep the analysis concise, data-driven, and actionable. Output in JSON format with these keys:
- trends (array of strings)
- topSuppliers (array of {name, country, frequency})
- geographicPatterns (array of strings)
- insights (array of strings)
- recommendations (array of strings)
- summary (string, 2-3 sentences)`;

  const fullPrompt = `${prompt || defaultPrompt}

--- DATA ---
${JSON.stringify(data, null, 2)}
--- END DATA ---`;

  const result = await model.generateContent(fullPrompt);
  const response = result.response;
  return response.text();
}

/**
 * Summarize and categorize a single company's import profile.
 */
export async function summarizeCompany(
  companyData: Record<string, unknown>
): Promise<string> {
  const client = getClient();
  const model = client.getGenerativeModel({ model: "gemini-2.0-flash" });

  const prompt = `Summarize this company's import profile in 2-3 sentences.
Include: main products, primary source countries, estimated import volume.
Output as JSON: { summary, mainProducts: string[], sourceCountries: string[], estimatedVolume: string }

Company data:
${JSON.stringify(companyData, null, 2)}`;

  const result = await model.generateContent(prompt);
  return result.response.text();
}
