/**
 * POST /api/webhooks/unipile
 * Receives Unipile push events: message_received, users.new_relation (invite accepted).
 * Deduped via WebhookEvent table (insert-on-conflict).
 * Full processing (mark replied, fire reply-alert email) is wired in Phase 2.
 */

import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/prisma";
import { config } from "@/config";

function verifySignature(body: string, sigHeader: string | null): boolean {
  if (!config.unipile.webhookSecret) return true; // dev — skip
  if (!sigHeader) return false;
  const expected = createHmac("sha256", config.unipile.webhookSecret)
    .update(body)
    .digest("hex");
  try {
    return timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected));
  } catch {
    return false;
  }
}

function extractDedupeId(eventType: string, data: Record<string, unknown>): string {
  if (eventType === "messaging.message_received") return String(data.message_id ?? data.id ?? "");
  if (eventType === "users.new_relation") {
    return `${data.account_id}:${data.user_provider_id}`;
  }
  return String(data.event_id ?? data.id ?? Math.random());
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const sig = req.headers.get("x-unipile-signature");

  if (!verifySignature(raw, sig)) {
    return new NextResponse("Invalid signature", { status: 401 });
  }

  let payload: { event?: string; type?: string; data?: Record<string, unknown> };
  try {
    payload = JSON.parse(raw);
  } catch {
    return new NextResponse("Invalid JSON", { status: 400 });
  }

  const eventType = payload.event ?? payload.type ?? "unknown";
  const data = payload.data ?? {};
  const dedupeId = extractDedupeId(eventType, data);

  // Dedup — skip already-processed events
  try {
    await prisma.webhookEvent.create({
      data: { id: `${eventType}:${dedupeId}`, provider: "unipile", eventType },
    });
  } catch {
    // Unique constraint violation = duplicate, ignore
    return NextResponse.json({ ok: true, duplicate: true });
  }

  // Phase 2: dispatch to handler by eventType
  // e.g. if (eventType === "messaging.message_received") await handleReply(data);
  // e.g. if (eventType === "users.new_relation") await handleInviteAccepted(data);

  console.log(`[webhook/unipile] ${eventType} processed (Phase 2 handler pending)`);
  return NextResponse.json({ ok: true });
}
