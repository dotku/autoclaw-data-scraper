variable "aws_region" {
  description = "Region for all infra. State bucket is fixed in us-east-1 (see main.tf backend)."
  type        = string
  default     = "us-east-1"
}

variable "name" {
  description = "Resource name prefix."
  type        = string
  default     = "autoclaw-data-scraper"
}

variable "schedule_expression" {
  description = "EventBridge Scheduler cron/rate. Default: daily at 02:00 UTC. Set to a long interval to keep cost (and API credit burn) minimal."
  type        = string
  default     = "cron(0 2 * * ? *)"
}

variable "schedule_enabled" {
  description = "Set false to deploy the function but NOT run it on a timer (invoke manually while testing to avoid burning API credits)."
  type        = bool
  default     = false
}

variable "lambda_memory_mb" {
  description = "Lambda memory. 512MB is plenty for HTTP-only collectors and keeps GB-seconds (and thus cost) low. More memory = more CPU = faster, but the job is I/O bound."
  type        = number
  default     = 512
}

variable "lambda_timeout_s" {
  description = "Max run time. A full 4-segment enriched run is ~2min; 300s leaves headroom. Cap below the 900s max to fail fast on hangs."
  type        = number
  default     = 300
}

variable "log_retention_days" {
  description = "CloudWatch log retention. Short retention caps the only recurring storage cost that isn't S3."
  type        = number
  default     = 14
}

# NOTE: API keys are intentionally NOT Terraform variables. They are injected
# directly into SSM (`aws ssm put-parameter --overwrite`) so secrets never pass
# through — or persist in — Terraform state. See ssm.tf and infra/README.md.
