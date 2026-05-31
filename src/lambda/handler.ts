/**
 * AWS Lambda entry point for the data-collection service.
 *
 * Invoked on a schedule by EventBridge Scheduler. Secrets are NOT passed as
 * plaintext env vars (which would persist in Terraform state). Instead the
 * function fetches them from SSM Parameter Store at runtime, decrypted with the
 * project KMS key. Only the SSM parameter PATH prefix arrives via env.
 *
 * Event shape (all optional): { client?: "sienovo-intl", only?: "<segment>", enrich?: boolean }
 */
import { runLeadTasks, CLIENT } from "../leads/sienovo-intl.js";

interface Event {
  client?: string;
  only?: string;
  enrich?: boolean;
}

const PLACEHOLDER = "REPLACE_VIA_CLI";

// SSM is organised by service source (provider), one OR MANY keys per provider:
//   <prefix>/<provider>/<label>   e.g. /autoclaw-data-scraper/apollo/default
// Each provider maps to the env var its collector reads from process.env.
const PROVIDER_ENV: Record<string, string> = {
  apollo: "APOLLO_API_KEY",
  "google-places": "GOOGLE_PLACES_API_KEY",
  hunter: "HUNTER_API_KEY",
};

/**
 * Pull SecureString params under SSM_PREFIX and export them as env vars so the
 * existing collectors (which read process.env) work unchanged.
 *
 * Multiple keys per provider are supported: the first becomes the canonical
 * env var (e.g. APOLLO_API_KEY), and all of them are exposed comma-joined as
 * <ENV>_POOL for future key rotation. Placeholder values are skipped.
 */
async function loadSecretsFromSSM(): Promise<void> {
  const prefix = process.env.SSM_PREFIX;
  if (!prefix) return; // local runs use .env.local instead
  const { SSMClient, GetParametersByPathCommand } = await import("@aws-sdk/client-ssm");
  const ssm = new SSMClient({});

  const pools: Record<string, string[]> = {};
  let token: string | undefined;
  do {
    const res = await ssm.send(
      new GetParametersByPathCommand({
        Path: prefix,
        Recursive: true,
        WithDecryption: true,
        NextToken: token,
      })
    );
    for (const p of res.Parameters ?? []) {
      const parts = (p.Name ?? "").split("/"); // .../<provider>/<label>
      const provider = parts[parts.length - 2];
      const env = PROVIDER_ENV[provider];
      if (env && p.Value && p.Value !== PLACEHOLDER) (pools[env] ??= []).push(p.Value);
    }
    token = res.NextToken;
  } while (token);

  for (const [env, keys] of Object.entries(pools)) {
    process.env[env] = keys[0];
    process.env[`${env}_POOL`] = keys.join(",");
  }
}

export async function handler(event: Event = {}) {
  await loadSecretsFromSSM();
  if (!process.env.APOLLO_API_KEY) throw new Error("APOLLO_API_KEY not configured in SSM");

  const client = event.client ?? CLIENT;
  if (client !== CLIENT) throw new Error(`Unknown client "${client}"`);

  const today = new Date().toISOString().split("T")[0];
  console.log(`[lambda] lead tasks for ${client} — ${today} (only=${event.only ?? "all"})`);

  const summary = await runLeadTasks({ only: event.only, enrich: event.enrich ?? true, today });

  const total = summary.reduce((n, s) => n + s.total, 0);
  console.log(`[lambda] done: ${total} leads across ${summary.length} segments`);
  return { ok: true, client, date: today, total, segments: summary };
}
