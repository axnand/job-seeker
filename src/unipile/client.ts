/**
 * Thin Unipile HTTP client (single-account: uses config.unipile + the owner's
 * one LinkedIn account). Endpoints verified against the live Unipile API and the
 * Hirro production integration:
 *   - invitations    POST   /users/invite
 *   - sent invites   GET    /users/invite/sent
 *   - cancel invite  DELETE /users/invite/sent/{id}
 *   - chats          POST   /chats                    (multipart/form-data)
 *   - chat messages  POST   /chats/{id}/messages      (multipart/form-data)
 *   - list messages  GET    /chats/{id}/messages
 *   - profile        GET    /users/{id}?linkedin_sections=*
 *   - search         POST   /linkedin/search          (jobs | posts | people)
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

  /** Distress signals that should trip the global pause (see account-safety). */
  get isRateLimited() {
    return this.status === 429;
  }
  get isAccountRestricted() {
    const c = (this.code ?? "").toLowerCase();
    const m = this.message.toLowerCase();
    return (
      c.includes("account_restricted") ||
      c.includes("limit_exceeded") ||
      c.includes("disconnected") ||
      m.includes("account_restricted") ||
      m.includes("limit_exceeded")
    );
  }
}

function baseUrl() {
  const raw = config.unipile.dsn;
  if (!raw) throw new Error("UNIPILE_DSN is not set");
  // Accept both "api21.unipile.com:15157" and "https://api21.unipile.com:15157"
  const dsn = raw.replace(/^https?:\/\//, "");
  return `https://${dsn}/api/v1`;
}

async function throwForStatus(res: Response, method: string, path: string): Promise<never> {
  const err = (await res.json().catch(() => ({}))) as { type?: string; title?: string; detail?: string };
  throw new UnipileError(
    err.title ?? err.detail ?? `Unipile ${method} ${path} failed (${res.status})`,
    res.status,
    err.type
  );
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
      Accept: "application/json",
      "X-API-KEY": config.unipile.apiKey,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) await throwForStatus(res, method, path);
  return res.json() as Promise<T>;
}

/** POST multipart/form-data — required by Unipile's /chats endpoints.
 *  Values can be strings or [Blob, filename] tuples for file attachments. */
async function requestForm<T>(
  path: string,
  fields: Record<string, string | [Blob, string]>
): Promise<T> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) form.append(k, v[0], v[1]);
    else form.append(k, v);
  }

  const res = await fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "X-API-KEY": config.unipile.apiKey,
      // No Content-Type — runtime sets the multipart boundary.
    },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) await throwForStatus(res, "POST", path);
  return res.json() as Promise<T>;
}

// ─── Accounts ────────────────────────────────────────────────────────────────

export async function listAccounts(): Promise<Array<{ id: string; type: string; name?: string }>> {
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

export interface LinkedinPersonItem {
  id?: string;
  provider_id?: string;
  public_identifier?: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  headline?: string;
  location?: string;
  profile_url?: string;
  network_distance?: string;
  current_company?: string;
}

/**
 * People search for the referral finder. Returns normalized person rows.
 * companyId/keywords are optional LinkedIn search filters.
 */
export async function searchPeople(
  accountId: string,
  opts: { keywords?: string; companyId?: string; limit?: number }
): Promise<LinkedinPersonItem[]> {
  const params: SearchParams = { api: "classic", category: "people" };
  if (opts.keywords) params.keywords = opts.keywords;
  if (opts.companyId) params.company = [opts.companyId];
  const res = await linkedinSearch<LinkedinPersonItem>(accountId, params);
  return (res.items ?? []).slice(0, opts.limit ?? 10);
}

/** Fetch full job detail (description, apply_url, hiring_team) for a job id. */
export async function getJobDetail(
  accountId: string,
  jobId: string
): Promise<{
  id: string; title: string; description?: string; apply_url?: string;
  location?: string; company?: string; company_id?: string; published_at?: number;
  hiring_team?: Array<{ name?: string; profile_url?: string; provider_id?: string; headline?: string }>;
}> {
  return request("GET", `/linkedin/jobs/${jobId}`, undefined, { account_id: accountId });
}

/** Fetch LinkedIn company profile by its numeric LinkedIn company_id. */
export async function getCompanyProfile(
  accountId: string,
  companyId: string,
): Promise<{
  name?: string;
  employee_count?: number;
  employee_count_range?: { from?: number; to?: number };
} | null> {
  try {
    return await request(
      "GET",
      `/linkedin/company/${encodeURIComponent(companyId)}`,
      undefined,
      { account_id: accountId },
    );
  } catch {
    return null;
  }
}

/**
 * List the posts authored by a specific LinkedIn user (or company).
 * GET /users/{identifier}/posts — `identifier` is a public_identifier or
 * provider_id. Newest-first. Used by the feed-watchlist source to monitor a
 * curated set of authors (LinkedIn exposes no home-timeline endpoint).
 */
export async function listUserPosts<T>(
  accountId: string,
  identifier: string,
  limit = 20,
  cursor?: string
): Promise<{ items: T[]; cursor?: string }> {
  const query: Record<string, string> = { account_id: accountId, limit: String(limit) };
  if (cursor) query.cursor = cursor;
  const data = await request<{ items?: T[]; cursor?: string } | T[]>(
    "GET",
    `/users/${encodeURIComponent(identifier)}/posts`,
    undefined,
    query
  );
  return Array.isArray(data) ? { items: data } : { items: data.items ?? [], cursor: data.cursor };
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
  name?: string;
  headline?: string;
  // Connection state — used to detect an already-connected target / silent accept.
  network_distance?: string;       // "FIRST_DEGREE" | "DISTANCE_1" | "SECOND_DEGREE" | ...
  is_relationship?: boolean;
  current_position?: Array<{ title?: string; company_name?: string }>;
}

export async function fetchProfile(
  accountId: string,
  identifier: string
): Promise<LinkedinProfile> {
  return request<LinkedinProfile>("GET", `/users/${encodeURIComponent(identifier)}`, undefined, {
    account_id: accountId,
    linkedin_sections: "*",
  });
}

/** True when the profile indicates an existing 1st-degree connection. */
export function isAlreadyConnected(p: { network_distance?: string; is_relationship?: boolean } | null | undefined): boolean {
  if (!p) return false;
  return (
    p.network_distance === "FIRST_DEGREE" ||
    p.network_distance === "DISTANCE_1" ||
    p.is_relationship === true
  );
}

// ─── Invites ─────────────────────────────────────────────────────────────────

export async function sendInvitation(
  accountId: string,
  providerUserId: string,
  message?: string
): Promise<{ invitationId: string }> {
  const res = await request<{ invitation_id?: string; id?: string }>("POST", "/users/invite", {
    account_id: accountId,
    provider_id: providerUserId,
    ...(message ? { message } : {}),
  });
  return { invitationId: res.invitation_id ?? res.id ?? "" };
}

export interface SentInvitation {
  id: string;                       // Unipile invitation id — used for DELETE
  invitedUserId: string | null;     // LinkedIn provider_id
  invitedUserPublicId: string | null;
  date: string;
}

/**
 * List sent (pending) invitations. Returns `null` on a fetch failure so callers
 * can distinguish "the API failed" from "no invites are pending" — critical for
 * acceptance inference: an empty list must never be read as "everyone accepted"
 * when it was actually an error. `limit` is clamped to 100 (Unipile rejects any
 * higher value with HTTP 400 invalid_parameters).
 */
export async function listSentInvitations(accountId: string, limit = 100): Promise<SentInvitation[] | null> {
  const safeLimit = Math.min(Math.max(1, limit), 100);
  try {
    const data = await request<{ items?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(
      "GET",
      "/users/invite/sent",
      undefined,
      { account_id: accountId, limit: String(safeLimit) }
    );
    const items = (Array.isArray(data) ? data : data.items ?? []) as Array<Record<string, unknown>>;
    return items.map((i) => ({
      id: String(i.id ?? ""),
      invitedUserId: (i.invited_user_id as string) ?? null,
      invitedUserPublicId: (i.invited_user_public_id as string) ?? null,
      date: (i.date as string) ?? "",
    }));
  } catch {
    return null;
  }
}

/** Cancel a pending sent invitation. Non-throwing. */
export async function cancelInvitation(accountId: string, invitationId: string): Promise<boolean> {
  try {
    await request("DELETE", `/users/invite/sent/${encodeURIComponent(invitationId)}`, undefined, {
      account_id: accountId,
    });
    return true;
  } catch {
    return false;
  }
}

// ─── Messaging ───────────────────────────────────────────────────────────────

export interface MessageAttachment {
  data: Buffer;
  filename: string;
}

export async function startChat(
  accountId: string,
  providerUserId: string,
  message: string,
  attachment?: MessageAttachment
): Promise<{ chatId: string; messageId: string }> {
  const fields: Record<string, string | [Blob, string]> = {
    account_id: accountId,
    attendees_ids: providerUserId,
    text: message,
  };
  if (attachment) {
    fields.attachments = [new Blob([new Uint8Array(attachment.data)], { type: "application/pdf" }), attachment.filename];
  }
  const res = await requestForm<{ chat_id?: string; id?: string; message_id?: string }>("/chats", fields);
  return { chatId: res.chat_id ?? res.id ?? "", messageId: res.message_id ?? "" };
}

export async function sendChatMessage(
  accountId: string,
  chatId: string,
  message: string,
  attachment?: MessageAttachment
): Promise<{ messageId: string }> {
  const fields: Record<string, string | [Blob, string]> = {
    account_id: accountId,
    text: message,
  };
  if (attachment) {
    fields.attachments = [new Blob([new Uint8Array(attachment.data)], { type: "application/pdf" }), attachment.filename];
  }
  const res = await requestForm<{ id?: string; message_id?: string }>(
    `/chats/${encodeURIComponent(chatId)}/messages`,
    fields
  );
  return { messageId: res.message_id ?? res.id ?? "" };
}

/** Recent messages in a chat (newest-first). Used by the reply-poll fallback. */
export async function listChatMessages(
  accountId: string,
  chatId: string,
  limit = 10
): Promise<Array<{ id: string; fromMe: boolean; text: string; date: string }>> {
  try {
    const data = await request<{ items?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(
      "GET",
      `/chats/${encodeURIComponent(chatId)}/messages`,
      undefined,
      { account_id: accountId, limit: String(limit) }
    );
    const items = (Array.isArray(data) ? data : data.items ?? []) as Array<Record<string, unknown>>;
    return items.map((m) => ({
      id: String(m.id ?? ""),
      // Unipile messages use `is_sender` (1 = us, 0 = them) and `timestamp`.
      // Keep the older field names as fallbacks for forward-compat.
      fromMe: m.is_sender === 1 || m.is_sender === true || m.from_me === true || m.is_from_me === true,
      text: String(m.text ?? m.body ?? ""),
      date: String(m.timestamp ?? m.date ?? m.created_at ?? ""),
    }));
  } catch {
    return [];
  }
}
