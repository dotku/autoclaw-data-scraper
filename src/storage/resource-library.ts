/**
 * Enterprise resource library writer.
 *
 * Two backends, chosen at runtime:
 *   - LEADS_BUCKET set  → write to S3   (used by the AWS Lambda)
 *   - otherwise         → write to ./resource-library/  (local CLI runs)
 *
 * Layout is identical on both:  <client>/<segment>/leads-<date>.{json,csv}
 * so the S3 bucket mirrors the local folder and can be synced down with
 * `aws s3 sync`.
 *
 * @aws-sdk/client-s3 is provided by the Lambda Node.js runtime (not bundled);
 * it's a devDependency locally only for types.
 */
import fs from "fs/promises";
import path from "path";

const LOCAL_ROOT = path.resolve(import.meta.dirname, "../../resource-library");

export interface WriteResult {
  backend: "s3" | "local";
  jsonPath: string;
  csvPath: string;
}

export async function writeLeads(
  client: string,
  segment: string,
  date: string,
  json: string,
  csv: string
): Promise<WriteResult> {
  const jsonKey = `${client}/${segment}/leads-${date}.json`;
  const csvKey = `${client}/${segment}/leads-${date}.csv`;
  const bucket = process.env.LEADS_BUCKET;

  if (bucket) {
    const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
    const s3 = new S3Client({});
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: jsonKey, Body: json, ContentType: "application/json" }));
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: csvKey, Body: csv, ContentType: "text/csv" }));
    return { backend: "s3", jsonPath: `s3://${bucket}/${jsonKey}`, csvPath: `s3://${bucket}/${csvKey}` };
  }

  const dir = path.join(LOCAL_ROOT, client, segment);
  await fs.mkdir(dir, { recursive: true });
  const jsonPath = path.join(dir, `leads-${date}.json`);
  const csvPath = path.join(dir, `leads-${date}.csv`);
  await fs.writeFile(jsonPath, json);
  await fs.writeFile(csvPath, csv);
  return { backend: "local", jsonPath, csvPath };
}

export async function writeManifest(client: string, date: string, manifest: unknown): Promise<void> {
  const body = JSON.stringify(manifest, null, 2);
  const key = `${client}/manifest-${date}.json`;
  const bucket = process.env.LEADS_BUCKET;
  if (bucket) {
    const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
    const s3 = new S3Client({});
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "application/json" }));
    return;
  }
  const dir = path.join(LOCAL_ROOT, client);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `manifest-${date}.json`), body);
}
