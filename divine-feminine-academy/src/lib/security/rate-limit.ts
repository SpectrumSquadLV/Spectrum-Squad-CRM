/**
 * Rate limiting.
 *
 * A fixed-window counter held in memory. Deliberately simple, and deliberately
 * honest about what it is: per-process, so on several instances each gets its
 * own window and the effective limit multiplies. It stops a script hammering
 * the magic-link endpoint from one address; it is not a defence against a
 * distributed attack.
 *
 * When this needs to be exact — or when there is more than one instance — the
 * store moves to Redis or Upstash behind the same interface.
 */

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  /** When the current window resets, as epoch ms. */
  resetAt: number
  retryAfterSeconds: number
}

interface Window {
  count: number
  resetAt: number
}

const store = new Map<string, Window>()

/** Stop the map growing without bound in a long-lived process. */
function sweep(now: number) {
  if (store.size < 5000) return
  for (const [key, window] of store) {
    if (window.resetAt <= now) store.delete(key)
  }
}

export function rateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
  now: number = Date.now(),
): RateLimitResult {
  sweep(now)

  const existing = store.get(key)

  if (!existing || existing.resetAt <= now) {
    const resetAt = now + windowSeconds * 1000
    store.set(key, { count: 1, resetAt })
    return {
      allowed: true,
      remaining: limit - 1,
      resetAt,
      retryAfterSeconds: 0,
    }
  }

  existing.count++

  const allowed = existing.count <= limit
  return {
    allowed,
    remaining: Math.max(0, limit - existing.count),
    resetAt: existing.resetAt,
    retryAfterSeconds: allowed
      ? 0
      : Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
  }
}

/** Only for tests. */
export function resetRateLimits() {
  store.clear()
}

/**
 * The client's address.
 *
 * Behind a proxy the socket address is the proxy's, so the forwarded headers
 * are used. They are spoofable by anyone talking to the origin directly, which
 * is another reason this is a speed bump rather than a security boundary.
 */
export function clientKey(request: Request, prefix: string): string {
  const forwarded = request.headers.get('x-forwarded-for')
  const ip =
    forwarded?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  return `${prefix}:${ip}`
}

export const LIMITS = {
  /** Magic links: generous enough for a typo, tight enough to stop a script. */
  authRequest: { limit: 5, windowSeconds: 900 },
  /** Anything that writes on behalf of a signed-in woman. */
  write: { limit: 60, windowSeconds: 60 },
  /** Public endpoints that hit the database. */
  publicRead: { limit: 120, windowSeconds: 60 },
} as const
