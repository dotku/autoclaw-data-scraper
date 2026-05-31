# ── Customer-managed KMS key (CMK) ──
# Enterprise standard: own the key (rotation, key policy, CloudTrail on usage,
# revocability) instead of AWS-managed keys. One CMK covers SSM SecureString
# and S3 SSE-KMS. ~$1/mo + negligible per-request.
resource "aws_kms_key" "main" {
  description             = "${var.name} — encrypts SSM secrets and S3 lead data"
  enable_key_rotation     = true
  deletion_window_in_days = 7
}

resource "aws_kms_alias" "main" {
  name          = "alias/${var.name}"
  target_key_id = aws_kms_key.main.key_id
}
