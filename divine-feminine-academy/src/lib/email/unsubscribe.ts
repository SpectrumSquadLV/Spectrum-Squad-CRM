import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Unsubscribe links that work without a login.
 *
 * A woman who joined an archetype sequence from a link a friend sent has never
 * had an account here. Sending her lifecycle email with an unsubscribe that
 * requires signing in is hostile, hurts deliverability, and in several places
 * she might live is not lawful. So the link has to work on its own.
 *
 * The token is a signature rather than a stored secret: nothing new to store,
 * nothing to leak from the database, and no row to go missing. It is
 * `<contactId>.<hmac>`, and the signature is checked in constant time.
 *
 * DOMAIN SEPARATION. The signing key is derived from the master key rather
 * than being the master key, so a token can never be used against anything
 * else that key protects. Rotating the master key invalidates every
 * outstanding unsubscribe link, which is acceptable — the footer in every
 * future email carries a fresh one.
 */

const PURPOSE = 'dfa:unsubscribe:v1'

function signingKey(): Buffer {
  const raw = process.env.JOURNAL_MASTER_KEY
  if (!raw) {
    throw new Error(
      'JOURNAL_MASTER_KEY is not set. Unsubscribe links cannot be signed without it.',
    )
  }
  const master = Buffer.from(raw, 'base64')
  if (master.length !== 32) {
    throw new Error(
      `JOURNAL_MASTER_KEY must decode to 32 bytes, got ${master.length}.`,
    )
  }
  return createHmac('sha256', master).update(PURPOSE).digest()
}

function sign(contactId: string): string {
  return createHmac('sha256', signingKey()).update(contactId).digest('base64url')
}

export function unsubscribeToken(contactId: string): string {
  return `${Buffer.from(contactId, 'utf8').toString('base64url')}.${sign(contactId)}`
}

/** The contact this token is for, or null if it is not a token we issued. */
export function verifyUnsubscribeToken(token: string): string | null {
  const parts = token.split('.')
  if (parts.length !== 2) return null

  const [encodedId, signature] = parts
  if (!encodedId || !signature) return null

  let contactId: string
  try {
    contactId = Buffer.from(encodedId, 'base64url').toString('utf8')
  } catch {
    return null
  }
  if (!contactId) return null

  let expected: string
  try {
    expected = sign(contactId)
  } catch {
    return null
  }

  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  // Length is checked first because timingSafeEqual throws on a mismatch. The
  // length of a signature is not a secret.
  if (a.length !== b.length) return null
  return timingSafeEqual(a, b) ? contactId : null
}

export function unsubscribeUrl(siteUrl: string, contactId: string): string {
  return `${siteUrl.replace(/\/$/, '')}/unsubscribe/${unsubscribeToken(contactId)}`
}
