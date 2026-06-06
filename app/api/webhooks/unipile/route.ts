/**
 * POST /api/webhooks/unipile
 * Inbound Unipile events:
 *   • users.new_relation / invitation_accepted → thread INVITE_PENDING → CONNECTED
 *   • messaging.message_received               → thread → REPLIED (+ reply alert)
 *
 * Deduped via WebhookEvent (per-event-type id). Auth: shared-secret header
 * (x-unipile-secret) — Unipile's supported mechanism — with an HMAC fallback for
 * setups that sign the body. The tick's poll fallbacks recover anything missed.
 */

import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/prisma";
import { config } from "@/config";
import { handleInboundReply } from "@/outreach/outreach-tick";
import { recomputeOutreachState } from "@/status/outreach-state";

export const dynamic = "force-dynamic";

// ─── Auth ──────────────────────────────────────────────────────────────────

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  try {
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

function verify(req: NextRequest, rawBody: string): boolean {
  const secret = config.unipile.webhookSecret;
  if (!secret) {
    // No secret configured: allow only outside production.
    return process.env.NODE_ENV !== "production";
  }
  // Preferred: shared-secret header (Unipile's supported mechanism).
  const headerSecret = req.headers.get("x-unipile-secret");
  if (headerSecret && safeEqual(headerSecret, secret)) return true;
  // Fallback: HMAC of the body.
  const sig = req.headers.get("x-unipile-signature");
  if (sig) {
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    if (safeEqual(sig, expected)) return true;
  }
  return false;
}

// ─── Dedupe ──────────────────────────────────────────────────────────────────

function extractDedupeId(eventType: string, data: Record<string, unknown>): string | null {
  switch (eventType) {
    case "users.new_relation":
    case "users_relations.invitation_accepted":
    case "new_relation":
      if (data.account_id && data.user_provider_id) return `${data.account_id}:${data.user_provider_id}`;
      return (data.invitation_id as string) ?? (data.event_id as string) ?? null;
    case "messaging.message_received":
    case "messaging.new_message":
    case "message_received":
      return (data.message_id as string) ?? (data.event_id as string) ?? null;
    default:
      return (data.event_id as string) ?? null;
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (!verify(req, raw)) {
    return new NextResponse("Invalid signature", { status: 401 });
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new NextResponse("Invalid JSON", { status: 400 });
  }

  // Normalize flat vs wrapped formats.
  let eventType: string;
  let data: Record<string, unknown>;
  if (parsed.type) {
    eventType = String(parsed.type);
    data = (parsed.data as Record<string, unknown>) ?? {};
  } else if (parsed.event) {
    eventType = String(parsed.event);
    data = parsed;
  } else if (parsed.webhook_name) {
    const map: Record<string, string> = {
      "outreach-relations": "new_relation",
      "outreach-messaging": "message_received",
    };
    eventType = map[String(parsed.webhook_name)] ?? String(parsed.webhook_name);
    data = parsed;
  } else {
    eventType = "unknown";
    data = parsed;
  }

  const dedupeId = extractDedupeId(eventType, data);
  if (dedupeId) {
    try {
      await prisma.webhookEvent.create({
        data: { id: `${eventType}:${dedupeId}`, provider: "unipile", eventType },
      });
    } catch {
      return NextResponse.json({ ok: true, duplicate: true });
    }
  }

  try {
    switch (eventType) {
      case "users.new_relation":
      case "users_relations.invitation_accepted":
      case "new_relation":
        await handleInviteAccepted(data);
        break;
      case "messaging.message_received":
      case "messaging.new_message":
      case "message_received":
        await handleMessageReceived(data);
        break;
      default:
        console.log(`[webhook/unipile] unhandled event: ${eventType}`);
    }
  } catch (err) {
    console.error(`[webhook/unipile] handler error for ${eventType}:`, (err as Error).message);
    return NextResponse.json({ ok: false, error: (err as Error).message });
  }

  return NextResponse.json({ ok: true });
}

// ─── Invite accepted ──────────────────────────────────────────────────────────

async function handleInviteAccepted(data: Record<string, unknown>) {
  const providerId =
    (data.user_provider_id as string) ??
    (data.user_public_identifier as string) ??
    (data.attendee_provider_id as string) ??
    (data.provider_id as string);
  if (!providerId) {
    console.warn("[webhook/unipile] invite-accepted: no provider id in payload");
    return;
  }

  const thread = await prisma.channelThread.findFirst({
    where: {
      candidateProviderId: providerId,
      status: { in: ["ACTIVE", "PENDING", "PAUSED"] },
      providerState: { path: ["phase"], equals: "INVITE_PENDING" },
    },
    select: { id: true, providerState: true, outreachId: true },
  });
  if (!thread) return;

  const res = await prisma.channelThread.updateMany({
    where: { id: thread.id, status: { in: ["ACTIVE", "PENDING"] } },
    data: {
      providerState: { ...(thread.providerState as object), phase: "CONNECTED" },
      nextActionAt: new Date(),
    },
  });
  if (res.count === 0) return;

  const jobId = await jobForOutreach(thread.outreachId);
  if (jobId) await recomputeOutreachState(jobId).catch(() => {});
  console.log(`[webhook/unipile] invite accepted → CONNECTED (thread ${thread.id.slice(-6)})`);
}

// ─── Message received ───────────────────────────────────────────────────────

async function handleMessageReceived(data: Record<string, unknown>) {
  const chatId = (data.chat_id as string) ?? (data.chatId as string) ?? ((data.chat as Record<string, unknown>)?.id as string);

  // Outbound echo detection (Unipile flat format).
  const accountUserId = (data.account_info as Record<string, unknown>)?.user_id as string | undefined;
  const senderProviderId = (data.sender as Record<string, unknown>)?.attendee_provider_id as string | undefined;
  const fromMe = data.is_from_me === true || data.from_me === true || (!!accountUserId && accountUserId === senderProviderId);
  if (fromMe) return;
  if (data.is_group === true) return;

  const text = String(
    (data.message as string) ?? (data.text as string) ?? ((data.message_obj as Record<string, unknown>)?.text as string) ?? ""
  );

  // Primary: match by chat id.
  if (chatId) {
    const threads = await prisma.channelThread.findMany({
      where: { providerChatId: chatId, status: { in: ["ACTIVE", "PENDING", "PAUSED"] } },
      select: { id: true, outreach: { include: { job: true, contact: true } } },
    });
    if (threads.length > 0) {
      for (const t of threads) await handleInboundReply(t.id, text, t.outreach);
      return;
    }
  }

  // Out-of-order fallback: message_received arrived before new_relation. The
  // thread is still INVITE_PENDING with no chatId. Match by sender provider id,
  // backfill chatId + CONNECTED, then mark REPLIED.
  const sender =
    senderProviderId ??
    ((data.from as Record<string, unknown>)?.provider_id as string) ??
    (data.provider_id as string);
  if (sender) {
    const thread = await prisma.channelThread.findFirst({
      where: { candidateProviderId: sender, status: { in: ["ACTIVE", "PENDING", "PAUSED"] } },
      select: { id: true, providerState: true, outreach: { include: { job: true, contact: true } } },
    });
    if (thread) {
      await prisma.channelThread.updateMany({
        where: { id: thread.id, status: { in: ["ACTIVE", "PENDING", "PAUSED"] } },
        data: {
          providerChatId: chatId ?? undefined,
          providerState: { ...(thread.providerState as object), phase: "CONNECTED" },
        },
      });
      await handleInboundReply(thread.id, text, thread.outreach);
      return;
    }
  }

  console.log(`[webhook/unipile] message_received: no thread for chatId=${chatId ?? "none"} sender=${sender ?? "none"}`);
}

async function jobForOutreach(outreachId: string | null): Promise<string | null> {
  if (!outreachId) return null;
  const o = await prisma.outreach.findUnique({ where: { id: outreachId }, select: { jobId: true } });
  return o?.jobId ?? null;
}
