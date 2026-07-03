/**
 * Shared HTTP retry helper for the external API clients (LLM providers + Unipile).
 *
 * Retries only on the transient failures worth retrying — HTTP 429, 5xx, and
 * network/abort errors — with exponential backoff + jitter. A 2xx or 4xx response
 * is returned as-is (the caller decides how to handle it); a network error that
 * survives all attempts is rethrown. Each attempt calls the supplied factory
 * fresh, so a per-attempt AbortSignal.timeout gets a new deadline each time.
 */

export interface RetryOptions {
  retries?: number;      // additional attempts after the first (default 2)
  baseDelayMs?: number;  // backoff base (default 300ms)
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function fetchWithRetry(
  doFetch: () => Promise<Response>,
  opts: RetryOptions = {},
): Promise<Response> {
  const retries = opts.retries ?? 2;
  const base = opts.baseDelayMs ?? 300;

  for (let attempt = 0; ; attempt++) {
    let res: Response | null = null;
    let networkErr: unknown = null;
    try {
      res = await doFetch();
    } catch (err) {
      networkErr = err;
    }

    const retryable = networkErr !== null || (res !== null && isRetryableStatus(res.status));
    if (!retryable || attempt >= retries) {
      if (networkErr !== null) throw networkErr;
      return res as Response;
    }

    // Exponential backoff (base, 2×base, 4×base…) plus up to `base` of jitter to
    // avoid a thundering herd of synchronized retries.
    const delay = base * 2 ** attempt + Math.random() * base;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
