output "resource_library_bucket" {
  description = "S3 bucket holding the lead data lake."
  value       = aws_s3_bucket.library.bucket
}

output "lambda_function_name" {
  value = aws_lambda_function.scraper.function_name
}

output "invoke_now_command" {
  description = "Run the collector on demand (doesn't wait for the schedule)."
  value       = "aws lambda invoke --function-name ${aws_lambda_function.scraper.function_name} --region ${var.aws_region} --cli-binary-format raw-in-base64-out --payload '{\"client\":\"sienovo-intl\",\"enrich\":true}' /dev/stdout"
}

output "sync_leads_command" {
  description = "Pull the resource library down to your machine."
  value       = "aws s3 sync s3://${aws_s3_bucket.library.bucket}/ ./resource-library/ --region ${var.aws_region}"
}

output "schedule_state" {
  value = "${aws_scheduler_schedule.daily.name}: ${aws_scheduler_schedule.daily.state} (${var.schedule_expression})"
}
