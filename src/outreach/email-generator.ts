/**
 * Automated outreach email generator.
 * Uses Gemini to generate personalized cold emails inviting companies
 * to join the AutoClaw platform, contribute business content, and connect.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";

export interface OutreachTarget {
  companyName: string;
  contactName?: string;
  contactTitle?: string;
  contactEmail?: string;
  industry?: string;
  country?: string;
  productDescription?: string;
  employeeCount?: string | number;
  linkedinUrl?: string;
  tradeValue?: number;
  supplierCount?: number;
}

export interface GeneratedEmail {
  to: string;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  language: "en" | "zh" | "es";
  targetCompany: string;
  contactName: string;
  generatedAt: string;
}

const EMAIL_SYSTEM_PROMPT = `You are a professional business development specialist for AutoClaw, a B2B trade intelligence platform that helps importers, exporters, and manufacturers connect directly.

Your job is to write compelling, personalized cold outreach emails that invite companies to:
1. Join the AutoClaw platform as a verified business
2. Showcase their products/services to potential trade partners
3. Connect with verified buyers/suppliers globally

Guidelines:
- Be professional but warm, not salesy
- Reference specific details about the company (products, trade volume, industry)
- Keep emails concise (150-200 words)
- Include a clear, low-commitment CTA (e.g., "claim your free business profile")
- Mention concrete benefits: verified trade data, global buyer network, free listing
- If the contact name is known, address them personally
- Do NOT use fake urgency or manipulative tactics
- Sign off as "AutoClaw Trade Platform Team"`;

export async function generateOutreachEmail(
  target: OutreachTarget,
  options: {
    language?: "en" | "zh" | "es";
    tone?: "formal" | "friendly";
    template?: "invitation" | "follow-up" | "partnership";
  } = {}
): Promise<GeneratedEmail> {
  const { language = "en", tone = "friendly", template = "invitation" } = options;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY required for email generation");

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

  const languageInstruction = {
    en: "Write the email in English.",
    zh: "Write the email in Chinese (简体中文). The subject line should also be in Chinese.",
    es: "Write the email in Spanish.",
  }[language];

  const templateInstruction = {
    invitation: "This is an initial invitation email to join the platform.",
    "follow-up": "This is a follow-up email. Be brief, reference a previous outreach, and offer to answer questions.",
    partnership: "This is a strategic partnership proposal. Emphasize mutual benefits and data sharing.",
  }[template];

  const prompt = `${EMAIL_SYSTEM_PROMPT}

${languageInstruction}
${templateInstruction}
Tone: ${tone}

Generate a cold outreach email for the following company. Output as JSON:
{
  "subject": "email subject line",
  "bodyHtml": "email body in HTML with <p> tags",
  "bodyText": "email body in plain text"
}

Company details:
- Company: ${target.companyName}
- Contact: ${target.contactName || "Unknown"} (${target.contactTitle || "Decision Maker"})
- Industry: ${target.industry || "Trade/Import-Export"}
- Country: ${target.country || "Unknown"}
- Products: ${target.productDescription || "Not specified"}
- Employee count: ${target.employeeCount || "Unknown"}
- Trade volume: ${target.tradeValue ? `$${target.tradeValue.toLocaleString()}` : "Unknown"}
- Known suppliers/partners: ${target.supplierCount || 0}
${target.linkedinUrl ? `- LinkedIn: ${target.linkedinUrl}` : ""}`;

  const result = await model.generateContent(prompt);
  const text = result.response.text();

  // Parse JSON from response (handle markdown code blocks)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Failed to parse email JSON from LLM response");
  }

  const parsed = JSON.parse(jsonMatch[0]) as {
    subject: string;
    bodyHtml: string;
    bodyText: string;
  };

  return {
    to: target.contactEmail || "",
    subject: parsed.subject,
    bodyHtml: parsed.bodyHtml,
    bodyText: parsed.bodyText,
    language,
    targetCompany: target.companyName,
    contactName: target.contactName || "",
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Generate outreach emails for a batch of targets.
 * Respects Gemini free tier rate limits (15 RPM).
 */
export async function generateOutreachBatch(
  targets: OutreachTarget[],
  options: {
    language?: "en" | "zh" | "es";
    tone?: "formal" | "friendly";
    template?: "invitation" | "follow-up" | "partnership";
    delayMs?: number;
  } = {}
): Promise<GeneratedEmail[]> {
  const { delayMs = 4500, ...emailOptions } = options;
  const emails: GeneratedEmail[] = [];

  for (const target of targets) {
    console.log(`[Outreach] Generating email for: ${target.companyName}`);
    try {
      // Auto-detect language based on country
      const lang =
        emailOptions.language ||
        detectLanguage(target.country || "");

      const email = await generateOutreachEmail(target, {
        ...emailOptions,
        language: lang,
      });
      emails.push(email);
    } catch (err) {
      console.warn(`[Outreach] Failed for ${target.companyName}:`, err);
    }

    // Rate limit: Gemini free tier is 15 RPM
    await new Promise((r) => setTimeout(r, delayMs));
  }

  console.log(`[Outreach] Generated ${emails.length}/${targets.length} emails`);
  return emails;
}

function detectLanguage(country: string): "en" | "zh" | "es" {
  const lower = country.toLowerCase();
  if (["china", "cn", "chn", "taiwan", "tw", "hong kong", "hk"].some((c) => lower.includes(c))) {
    return "zh";
  }
  if (["spain", "mexico", "colombia", "argentina", "chile", "peru"].some((c) => lower.includes(c))) {
    return "es";
  }
  return "en";
}
