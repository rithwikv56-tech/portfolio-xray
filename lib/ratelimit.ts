// Rate limiter with two backends:
//  - If UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set, uses Upstash
//    Redis (works across serverless instances — correct for production at scale).
//  - Otherwise falls back to in-memory (fine for a single instance / local dev).
//
// No hard dependency on Upstash: we call its REST API with fetch only if configured.

const WINDOW_MS = 60_000;     // 1 minute
const MAX_PER_WINDOW = 6;     // analyses / minute / IP
const DAILY_MAX = 40;         // analyses / day / IP

type Bucket = { count: number; resetAt: number };
const minuteBuckets = new Map<string, Bucket>();
const dayBuckets = new Map<string, Bucket>();

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const useRedis = Boolean(REDIS_URL && REDIS_TOKEN);

function takeMemory(map: Map<string, Bucket>, key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const b = map.get(key);
  if (!b || now > b.resetAt) {
    map.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, resetAt: now + windowMs };
  }
  if (b.count >= limit) return { ok: false, resetAt: b.resetAt };
  b.count += 1;
  return { ok: true, resetAt: b.resetAt };
}

// Upstash: INCR then EXPIRE on first hit. Atomic enough for rate limiting.
async function takeRedis(key: string, limit: number, windowSec: number) {
  try {
    const incr = await fetch(`${REDIS_URL}/incr/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
      cache: "no-store",
    });
    const { result: count } = (await incr.json()) as { result: number };
    if (count === 1) {
      await fetch(`${REDIS_URL}/expire/${encodeURIComponent(key)}/${windowSec}`, {
        headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
        cache: "no-store",
      });
    }
    return { ok: count <= limit };
  } catch {
    // If Redis is unreachable, fail open (don't block legit users) but log.
    console.error("Rate-limit Redis error — failing open");
    return { ok: true };
  }
}

export async function checkRateLimit(ip: string): Promise<{ ok: boolean; message: string }> {
  if (useRedis) {
    const min = await takeRedis(`rl:m:${ip}`, MAX_PER_WINDOW, 60);
    if (!min.ok) return { ok: false, message: "Too many requests. Please wait a minute and try again." };
    const day = await takeRedis(`rl:d:${ip}`, DAILY_MAX, 24 * 60 * 60);
    if (!day.ok) return { ok: false, message: "Daily analysis limit reached. Please come back tomorrow." };
    return { ok: true, message: "" };
  }

  // In-memory fallback
  if (minuteBuckets.size > 5000) {
    const now = Date.now();
    for (const [k, v] of minuteBuckets) if (now > v.resetAt) minuteBuckets.delete(k);
  }
  const min = takeMemory(minuteBuckets, ip, MAX_PER_WINDOW, WINDOW_MS);
  if (!min.ok) {
    const secs = Math.ceil((min.resetAt - Date.now()) / 1000);
    return { ok: false, message: `Too many requests. Try again in ${secs}s.` };
  }
  const day = takeMemory(dayBuckets, `d:${ip}`, DAILY_MAX, 24 * 60 * 60 * 1000);
  if (!day.ok) return { ok: false, message: "Daily analysis limit reached. Please come back tomorrow." };
  return { ok: true, message: "" };
}

export function getClientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}
