/**
 * Minimal S3 helper for resume storage.
 * Uploads PDFs and issues short-lived presigned download URLs.
 */

import { S3Client, PutObjectCommand, GetObjectCommand, GetObjectCommandOutput } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "@/config";

let _client: S3Client | null = null;

function client(): S3Client {
  if (!_client) {
    _client = new S3Client({
      region: config.s3.region,
      credentials: {
        accessKeyId:     process.env.AWS_ACCESS_KEY_ID ?? "",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
      },
    });
  }
  return _client;
}

export async function uploadResume(
  key: string,
  body: Buffer,
  contentType = "application/pdf"
): Promise<string> {
  await client().send(new PutObjectCommand({
    Bucket: config.s3.bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
  return key;
}

/** Download a resume from S3 and return its raw bytes. */
export async function downloadResume(key: string): Promise<Buffer> {
  const res: GetObjectCommandOutput = await client().send(
    new GetObjectCommand({ Bucket: config.s3.bucket, Key: key })
  );
  const chunks: Uint8Array[] = [];
  for await (const chunk of res.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Presigned GET URL, valid for 1 hour. */
export async function resumeDownloadUrl(key: string): Promise<string> {
  return getSignedUrl(
    client(),
    new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }),
    { expiresIn: 3600 }
  );
}

export function isS3Configured(): boolean {
  return !!(config.s3.bucket && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
}
