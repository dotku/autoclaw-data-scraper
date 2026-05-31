# ── Enterprise resource library: the lead data lake ──
# Mirrors the local resource-library/ layout: <client>/<segment>/leads-<date>.json
resource "aws_s3_bucket" "library" {
  bucket = "${var.name}-resource-library-${data.aws_caller_identity.current.account_id}"
}

# Keep history of each run without unbounded cost — version, then expire old
# noncurrent copies. Current objects are tiny (KB), so this stays in pennies.
resource "aws_s3_bucket_versioning" "library" {
  bucket = aws_s3_bucket.library.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "library" {
  bucket = aws_s3_bucket.library.id
  rule {
    id     = "expire-old-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

# Private bucket — leads are internal data.
resource "aws_s3_bucket_public_access_block" "library" {
  bucket                  = aws_s3_bucket.library.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "library" {
  bucket = aws_s3_bucket.library.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.main.arn
    }
    # Bucket keys cut KMS API calls (and cost) by ~99% for many small objects.
    bucket_key_enabled = true
  }
}

# Enforce HTTPS — deny any request not over TLS. Standard public-company control.
data "aws_iam_policy_document" "library_tls" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.library.arn, "${aws_s3_bucket.library.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "library" {
  bucket = aws_s3_bucket.library.id
  policy = data.aws_iam_policy_document.library_tls.json
}
