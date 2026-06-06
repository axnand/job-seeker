/**
 * GET /api/webhooks/approval?token=<signed-token>
 * Called when the owner clicks Approve or Skip in the digest email.
 * Verifies the signed token, then redirects to the dashboard job detail page
 * (with a ?action= param) so the owner reviews the outreach message before anything sends.
 * Nothing auto-sends on this route — that happens in the dashboard on explicit confirm.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyActionToken } from "@/lib/tokens";
import { config } from "@/config";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");

  if (!token) {
    return new NextResponse("Missing token", { status: 400 });
  }

  const payload = verifyActionToken(token);
  if (!payload) {
    return new NextResponse("Invalid or expired token", { status: 400 });
  }

  // Redirect to dashboard — the actual status change happens there after review
  const redirectUrl = new URL(`/jobs/${payload.jobId}`, config.app.baseUrl);
  redirectUrl.searchParams.set("action", payload.action);

  return NextResponse.redirect(redirectUrl.toString());
}
