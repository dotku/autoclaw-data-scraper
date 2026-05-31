# ── Deployment package ──
# Zips dist/ (run `npm run build:lambda` first). source_code_hash triggers a
# redeploy whenever the bundle changes.
data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = "${path.module}/../dist"
  output_path = "${path.module}/lambda.zip"
}

# ── IAM: least privilege ──
data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${var.name}-lambda"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "lambda" {
  # Write leads to the resource-library bucket (SSE-KMS).
  statement {
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.library.arn}/*"]
  }
  # Read decrypted API keys from SSM at runtime. GetParametersByPath authorizes
  # against the PATH NODE itself (parameter/<name>), while GetParameter targets
  # the child params (parameter/<name>/*) — both ARNs are required.
  statement {
    actions = ["ssm:GetParametersByPath", "ssm:GetParameter", "ssm:GetParameters"]
    resources = [
      "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/${var.name}",
      "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/${var.name}/*",
    ]
  }
  # Use the project CMK: decrypt SSM SecureStrings, and encrypt/decrypt S3 objects.
  statement {
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.main.arn]
  }
}

resource "aws_iam_role_policy" "lambda" {
  name   = "${var.name}-lambda"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda.json
}

# AWS-managed policy for CloudWatch Logs.
resource "aws_iam_role_policy_attachment" "logs" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Explicit log group so retention (and cost) is controlled.
resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${var.name}"
  retention_in_days = var.log_retention_days
}

# ── The function ──
# No VPC → free outbound internet (avoids a ~$32/mo NAT Gateway). Fine because
# it only calls public APIs (Apollo/Places/Hunter) and S3.
resource "aws_lambda_function" "scraper" {
  function_name    = var.name
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  memory_size      = var.lambda_memory_mb
  timeout          = var.lambda_timeout_s

  # No secrets here — only the SSM path the function reads at runtime.
  environment {
    variables = {
      LEADS_BUCKET = aws_s3_bucket.library.bucket
      SSM_PREFIX   = local.ssm_prefix
    }
  }

  depends_on = [aws_cloudwatch_log_group.lambda]
}
