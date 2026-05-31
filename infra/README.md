# AutoClaw Data Scraper — AWS infra (OpenTofu/Terraform)

Minimal-cost, serverless data-collection service. No always-on compute, no
database, no NAT gateway. Reuses the existing `sienovo-tofu-state` backend.

## Architecture

```
EventBridge Scheduler (daily cron, DISABLED by default)
  └─> Lambda (nodejs22, 512MB, no VPC)   ── reads keys from env (SSM-backed)
        ├─> Apollo / Google Places / Hunter   (public APIs)
        └─> S3  s3://<bucket>/sienovo-intl/<segment>/leads-<date>.{json,csv}
CloudWatch Logs (14-day retention)
```

## Deploy

Secrets are NEVER passed through Terraform. Terraform only creates empty,
KMS-encrypted SSM placeholders; the real keys are injected separately so they
never touch Terraform state.

```bash
# 1. Build the Lambda bundle (Terraform zips ../dist)
npm run build:lambda

# 2. Provision infra (no secrets involved)
cd infra
terraform init            # uses sienovo-tofu-state backend
terraform plan            # review the full plan
terraform apply

# 3. Inject API keys out-of-band, straight into SSM (never into state).
#    Path is <prefix>/<provider>/<label>. Apollo required; Places/Hunter optional.
aws ssm put-parameter --overwrite --name /autoclaw-data-scraper/apollo/default \
  --type SecureString --key-id alias/autoclaw-data-scraper \
  --value "$APOLLO_API_KEY" --region us-east-1
# One provider, many keys: add more for quota/rotation under the same provider:
#   aws ssm put-parameter --name /autoclaw-data-scraper/apollo/backup-1 ...
# Other providers: /autoclaw-data-scraper/google-places/default , .../hunter/default

# 4. Test on demand (schedule stays off until you set schedule_enabled=true).
#    The exact command is printed as the `invoke_now_command` output.
```

Flip to scheduled mode by setting `schedule_enabled = true` (and adjust
`schedule_expression`) once you're happy with the output — kept off by default
so it doesn't burn API credits during setup.

## Cost (us-east-1, daily run)

| Service | Notes | Monthly |
|---|---|---|
| Lambda | ~30 runs × ~2min @ 512MB ≈ 1.8k GB-s (free tier 400k) | **$0** |
| S3 | KB–hundreds of MB, versioned w/ 90d expiry | **<$0.10** |
| EventBridge Scheduler | 30/mo vs 14M free | **$0** |
| SSM Parameter Store | SecureString, standard tier | **$0** |
| CloudWatch Logs | few KB/run, 14d retention | **$0** |
| **AWS total** | | **≈ $0–1/mo** |

The real spend is the data APIs (Apollo / Places / Hunter), not AWS — all have
free tiers that cover MVP volume.
