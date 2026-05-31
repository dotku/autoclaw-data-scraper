terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
  # Reuse the existing sienovo OpenTofu state bucket (created for sienovo-intl).
  # S3-native locking (use_lockfile) replaces the deprecated dynamodb_table —
  # a .tflock object beside the state, no DynamoDB needed. Independent of other
  # projects still using the lock table.
  backend "s3" {
    bucket       = "sienovo-tofu-state"
    key          = "autoclaw-data-scraper/terraform.tfstate"
    region       = "us-east-1"
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = {
      Project   = "autoclaw-data-scraper"
      ManagedBy = "OpenTofu"
      Repo      = "autoclaw/autoclaw-data-scraper"
    }
  }
}

data "aws_caller_identity" "current" {}
