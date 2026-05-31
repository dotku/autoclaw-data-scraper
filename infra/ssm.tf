# ── API keys in SSM Parameter Store ──
# Organised by SERVICE SOURCE (provider), supporting MANY keys per provider:
#   <prefix>/<provider>/<label>   e.g. /autoclaw-data-scraper/apollo/default
#
# Terraform seeds ONE empty placeholder per provider (apollo/default, ...).
# Add more keys for the same provider any time with `aws ssm put-parameter`
# (e.g. .../apollo/backup-1) — the Lambda discovers all of them by path.
#
# Public-company secret hygiene: Terraform creates the parameter as an empty
# PLACEHOLDER and never sees the real value (injected out-of-band so it never
# lands in Terraform state). Encrypted with the project CMK.
locals {
  ssm_prefix = "/${var.name}"
  # provider => list of key labels to seed
  providers = {
    apollo        = ["default"]
    google-places = ["default"]
    hunter        = ["default"]
  }
  # Flatten to "<provider>/<label>" keys for for_each.
  seed_params = merge([
    for provider, labels in local.providers : {
      for label in labels : "${provider}/${label}" => { provider = provider, label = label }
    }
  ]...)
}

resource "aws_ssm_parameter" "api_keys" {
  for_each = local.seed_params
  name     = "${local.ssm_prefix}/${each.key}"
  type     = "SecureString"
  key_id   = aws_kms_key.main.id
  value    = "REPLACE_VIA_CLI"

  lifecycle {
    ignore_changes = [value]
  }
}
