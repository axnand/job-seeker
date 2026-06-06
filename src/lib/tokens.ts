/**
 * Signed, expiring tokens for email Approve/Skip links.
 * Uses HMAC-SHA256 over a payload string — no external JWT library needed.
 */

import { config } from "@/config";
import { createHmac, timingSafeEqual } from "crypto";

const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function createActionToken(jobId: string, action: "approve" | "skip"): string {
  const expiresAt = Date.now() + TTL_MS;
  const payload = `${jobId}:${action}:${expiresAt}`;
  const sig = sign(payload);
  return Buffer.from(`${payload}:${sig}`).toString("base64url");
}

export interface TokenPayload {
  jobId: string;
  action: "approve" | "skip";
}

export function verifyActionToken(token: string): TokenPayload | null {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf-8");
    const parts = decoded.split(":");
    if (parts.length !== 4) return null;

    const [jobId, action, expiresAtStr, sig] = parts;
    const payload = `${jobId}:${action}:${expiresAtStr}`;

    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(sign(payload)))) return null;
    if (Date.now() > Number(expiresAtStr)) return null;
    if (action !== "approve" && action !== "skip") return null;

    return { jobId, action };
  } catch {
    return null;
  }
}

function sign(payload: string): string {
  return createHmac("sha256", config.auth.secret).update(payload).digest("hex");
}
