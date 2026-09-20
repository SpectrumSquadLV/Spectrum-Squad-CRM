import { createHmac, timingSafeEqual } from 'node:crypto'
import { WebhookVerificationError } from './provider'

/**
 * Stripe webhook signature verification.
 *
 * Implemented here rather than pulled from an SDK so it can be TESTED: an
 * unverified webhook is an anonymous HTTP request claiming somebody paid, and
 * "we trust the SDK" is not the same as knowing this rejects a forgery.
 *
 * The scheme: the `Stripe-Signature` header carries `t=<unix>,v1=<hex>` where
 * v1 is HMAC-SHA256 of `${t}.${rawBody}` keyed with the endpoint secret.
 */

const DEFAULT_TOLERANCE_SECONDS = 300

export interface ParsedSignature {
  timestamp: number
  signatures: string[]
}

export function parseSignatureHeader(header: string): ParsedSignature {
  let timestamp = 0
  const signatures: string[] = []

  for (const part of header.split(',')) {
    const [key, value] = part.split('=', 2)
    if (!key || !value) continue
    if (key.trim() === 't') timestamp = Number(value.trim())
    // A header can carry several v1 signatures during a secret rotation.
    if (key.trim() === 'v1') signatures.push(value.trim())
  }

  return { timestamp, signatures }
}

export function computeSignature(
  payload: string,
  timestamp: number,
  secret: string,
): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${payload}`, 'utf8')
    .digest('hex')
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/**
 * Throws unless the signature verifies and is recent.
 *
 * The timestamp check is what stops a replay: without it, anyone who ever saw
 * one valid webhook could resend it forever.
 */
export function verifySignature(
  payload: string,
  header: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
): void {
  if (!secret) throw new WebhookVerificationError('No webhook secret is configured.')
  if (!header) throw new WebhookVerificationError('No signature header.')

  const { timestamp, signatures } = parseSignatureHeader(header)

  if (!timestamp || !Number.isFinite(timestamp)) {
    throw new WebhookVerificationError('Signature header has no timestamp.')
  }
  if (signatures.length === 0) {
    throw new WebhookVerificationError('Signature header has no v1 signature.')
  }

  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    throw new WebhookVerificationError('Webhook timestamp is outside the tolerance.')
  }

  const expected = computeSignature(payload, timestamp, secret)
  const matched = signatures.some((candidate) =>
    constantTimeEquals(candidate, expected),
  )

  if (!matched) throw new WebhookVerificationError()
}
