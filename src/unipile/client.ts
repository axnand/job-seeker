/**
 * Thin Unipile HTTP client.
 * Each function takes explicit (dsn, apiKey) so it works without the config
 * singleton in contexts where env vars might differ.
 */

import { config } from "@/config";

export class UnipileError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string
  ) {
    super(message);
    this.name = "UnipileError";
  }
}

function baseUrl() {
  const raw = config.unipile.dsn;
  if (!raw) throw new Error("UNIPILE_DSN is not set");
  // Accept both "api21.unipile.com:15157" and "https://api21.unipile.com:15157"
  const dsn = raw.replace(/^https?:\/\//, "");
  return `https://${dsn}/api/v1`;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  params?: Record<string, string>
): Promise<T> {
  const url = new URL(`${baseUrl()}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": config.unipile.apiKey,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { type?: string; title?: string };
    throw new UnipileError(
      err.title ?? `Unipile ${method} ${path} failed`,
      res.status,
      err.type
    );
  }

  return res.json() as Promise<T>;
}

// ─── Accounts ────────────────────────────────────────────────────────────────

export async function listAccounts(): Promise<Array<{ id: string; type: string; name?: string; connection_params?: Record<string, unknown> }>> {
  const data = await request<{ items: Array<{ id: string; type: string; name?: string }> }>("GET", "/accounts");
  return data.items ?? [];
}

// ─── Search ──────────────────────────────────────────────────────────────────

export interface SearchParams {
  api: "classic";
  category: "jobs" | "posts" | "people" | "companies";
  keywords?: string;
  [key: string]: unknown;
}

export async function linkedinSearch<T>(
  accountId: string,
  params: SearchParams,
  cursor?: string
): Promise<{ items: T[]; cursor?: string }> {
  // account_id MUST be a query param, not in the body.
  const query: Record<string, string> = { account_id: accountId };
  if (cursor) query.cursor = cursor;
  return request<{ items: T[]; cursor?: string }>("POST", "/linkedin/search", params, query);
}

/** Fetch full job detail (description, apply_url, hiring_team) for a job id. */
export async function getJobDetail(
  accountId: string,
  jobId: string
): Promise<{
  id: string; title: string; description?: string; apply_url?: string;
  location?: string; company?: string; published_at?: number;
  hiring_team?: Array<{ name: string; profile_url: string; provider_id?: string }>;
}> {
  return request("GET", `/linkedin/jobs/${jobId}`, undefined, { account_id: accountId });
}

/** Resolve text (location, company, etc.) to LinkedIn IDs. */
export async function resolveSearchParam(
  accountId: string,
  type: "LOCATION" | "COMPANY" | "JOB_TITLE" | "INDUSTRY" | "PEOPLE",
  keywords: string
): Promise<Array<{ id: string; title: string }>> {
  const data = await request<{ items: Array<{ id: string; title: string }> }>(
    "GET",
    "/linkedin/search/parameters",
    undefined,
    { account_id: accountId, type, keywords, limit: "5" }
  );
  return data.items;
}

// ─── Profile ─────────────────────────────────────────────────────────────────

export interface LinkedinProfile {
  provider_id: string;
  public_identifier?: string;
  profile_url?: string;
  first_name?: string;
  last_name?: string;
  headline?: string;
  current_position?: Array<{ title?: string; company_name?: string }>;
}

export async function fetchProfile(
  accountId: string,
  identifier: string
): Promise<LinkedinProfile> {
  return request<LinkedinProfile>("GET", `/users/${identifier}`, undefined, {
    account_id: accountId,
  });
}

// ─── Invites ─────────────────────────────────────────────────────────────────

export async function sendInvitation(
  accountId: string,
  providerUserId: string,
  message?: string
): Promise<{ invitation_id?: string }> {
  return request("POST", "/linkedin/invitations", {
    account_id: accountId,
    provider_id: providerUserId,
    ...(message ? { message } : {}),
  });
}

export async function listSentInvitations(
  accountId: string,
  cursor?: string
): Promise<{ items: Array<{ provider_id: string; status: string; created_at: number }>; cursor?: string }> {
  const params: Record<string, string> = { account_id: accountId };
  if (cursor) params.cursor = cursor;
  return request("GET", "/linkedin/invitations/sent", undefined, params);
}

// ─── Messaging ───────────────────────────────────────────────────────────────

export async function startChat(
  accountId: string,
  providerUserId: string,
  message: string
): Promise<{ chat_id?: string; message_id?: string }> {
  return request("POST", "/chats", {
    account_id: accountId,
    attendees_ids: [providerUserId],
    text: message,
  });
}

export async function sendChatMessage(
  accountId: string,
  chatId: string,
  message: string
): Promise<{ message_id?: string }> {
  return request("POST", `/chats/${chatId}/messages`, {
    account_id: accountId,
    text: message,
  });
}

export async function listChatMessages(
  chatId: string,
  accountId: string,
  cursor?: string
): Promise<{ items: Array<{ message_id: string; sender?: { provider_id: string }; text?: string; created_at: number }>; cursor?: string }> {
  const params: Record<string, string> = { account_id: accountId };
  if (cursor) params.cursor = cursor;
  return request("GET", `/chats/${chatId}/messages`, undefined, params);
}
