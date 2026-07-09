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

/**
 * Download a resume from S3 and return its raw bytes.
 *
 * Retries transient failures: rapid-fire GetObject bursts (a tick sending many
 * DMs) occasionally hit S3 throttling / network blips, and the caller
 * (doSendFirstDm) treats a throw as "no resume" — which is how DMs went out
 * PDF-less intermittently. A couple of quick retries make a transient blip a
 * non-event; a persistent failure still throws so the caller can defer the send.
 */
export async function downloadResume(key: string, attempts = 3): Promise<Buffer> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res: GetObjectCommandOutput = await client().send(
        new GetObjectCommand({ Bucket: config.s3.bucket, Key: key })
      );
      const chunks: Uint8Array[] = [];
      for await (const chunk of res.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
      return Buffer.concat(chunks);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr;
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
