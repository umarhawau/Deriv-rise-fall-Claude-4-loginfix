/**
 * In-memory brute-force protection for the admin login.
 * Tracks failed attempts per IP and applies a 15-minute lockout after 5 failures.
 * Module-level Map persists across requests within a single process.
 */

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

interface AttemptRecord {
  count: number;
  lockedUntil: number; // 0 = not locked
}

const store = new Map<string, AttemptRecord>();

export interface LockoutStatus {
  allowed: boolean;
  /** Attempts remaining before lockout (only valid when allowed = true) */
  remaining: number;
  /** Seconds until the lockout expires (only valid when allowed = false) */
  retryAfterSec: number;
}

export function checkLockout(ip: string): LockoutStatus {
  const now = Date.now();
  const rec = store.get(ip);

  if (!rec) {
    return { allowed: true, remaining: MAX_ATTEMPTS, retryAfterSec: 0 };
  }

  // Lock expired — clean up and allow
  if (rec.lockedUntil > 0 && rec.lockedUntil <= now) {
    store.delete(ip);
    return { allowed: true, remaining: MAX_ATTEMPTS, retryAfterSec: 0 };
  }

  // Still locked
  if (rec.lockedUntil > now) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSec: Math.ceil((rec.lockedUntil - now) / 1000),
    };
  }

  return {
    allowed: true,
    remaining: MAX_ATTEMPTS - rec.count,
    retryAfterSec: 0,
  };
}

/** Record one failed attempt. Returns the updated lockout status. */
export function recordFailure(ip: string): LockoutStatus {
  const now = Date.now();
  const rec = store.get(ip) ?? { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockedUntil = now + LOCKOUT_MS;
  }
  store.set(ip, rec);
  return checkLockout(ip);
}

/** Clear all failed attempts for an IP (called on successful login). */
export function clearAttempts(ip: string): void {
  store.delete(ip);
}
