/**
 * Daily-cached FX rates via open.er-api.com (free, no key needed).
 * Returns conversion rate: 1 unit of `from` = N units of `to`.
 */

interface RateCache {
  base: string;
  rates: Record<string, number>;
  fetchedAt: number;
}

let cache: RateCache | null = null;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

async function getRates(base = "USD"): Promise<Record<string, number>> {
  const now = Date.now();
  if (cache && cache.base === base && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.rates;
  }

  const res = await fetch(`https://open.er-api.com/v6/latest/${base}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`FX fetch failed: ${res.status}`);
  const data = await res.json() as { rates: Record<string, number> };

  cache = { base, rates: data.rates, fetchedAt: now };
  return data.rates;
}

/** Convert `amount` from `from` currency to `to` currency. */
export async function convertCurrency(
  amount: number,
  from: string,
  to: string
): Promise<number> {
  if (from === to) return amount;

  // Rates are relative to USD; go via USD
  const usdRates = await getRates("USD");

  const fromRate = from === "USD" ? 1 : (usdRates[from] ?? null);
  const toRate = to === "USD" ? 1 : (usdRates[to] ?? null);

  if (!fromRate || !toRate) {
    throw new Error(`Unknown currency: ${from} or ${to}`);
  }

  return (amount / fromRate) * toRate;
}
