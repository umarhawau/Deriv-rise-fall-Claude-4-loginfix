/**
 * Simple in-memory sliding-window rate limiter.
 * Suitable for single-process deployments (Next.js dev / single-instance prod).
 * For multi-instance production deployments, swap the Map for a Redis/Upstash store.
 */

interface WindowRecord {
  count: number;
  windowStart: number;
}

const store = new Map<string, WindowRecord>();

export interface RateLimitOptions {
  /** Maximum requests allowed within the window */
  limit: number;
  /** Window duration in milliseconds */
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export function checkRateLimit(key: string, opts: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  const rec = store.get(key);

  // New window (first request or window has rolled over)
  if (!rec || now - rec.windowStart >= opts.windowMs) {
    store.set(key, { count: 1, windowStart: now });
    return { allowed: true, remaining: opts.limit - 1, retryAfterMs: 0 };
  }

  // Window full
  if (rec.count >= opts.limit) {
    const retryAfterMs = opts.windowMs - (now - rec.windowStart);
    return { allowed: false, remaining: 0, retryAfterMs };
  }

  rec.count += 1;
  return { allowed: true, remaining: opts.limit - rec.count, retryAfterMs: 0 };
}

/** Extract the client IP from a Next.js request. */
export function getClientIp(req: { headers: { get(name: string): string | null } }): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown"
  );
}

/** Build a standard 429 Too Many Requests response. */
export function rateLimitResponse(retryAfterMs: number): Response {
  const retryAfterSec = Math.ceil(retryAfterMs / 1000);
  return Response.json(
    {
      error: "Rate limit exceeded — too many requests. Please wait and try again.",
      retryAfterSec,
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfterSec),
        "X-RateLimit-Reset": String(Date.now() + retryAfterMs),
      },
    }
  );
}
