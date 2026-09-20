import 'server-only'
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

/**
 * Journal encryption.
 *
 * Two-tier envelope encryption:
 *   - Each contact has her own 32-byte data key.
 *   - That data key is stored wrapped (encrypted) by a master key that lives
 *     in the environment/secrets manager, never in the database.
 *
 * The consequence is deliberate: opening the database shows ciphertext. Not to
 * a developer, not to a support contractor, not to the owner. Admin screens
 * read metadata only (counts, dates, categories, word counts).
 *
 * Deleting a contact's wrapped key makes every entry of hers permanently
 * unreadable, which is how an account deletion request is honoured.
 */

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

function masterKey(): Buffer {
  const raw = process.env.JOURNAL_MASTER_KEY
  if (!raw) {
    throw new Error(
      'JOURNAL_MASTER_KEY is not set. Journal entries cannot be read or written without it.',
    )
  }
  const key = Buffer.from(raw, 'base64')
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `JOURNAL_MASTER_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}.`,
    )
  }
  return key
}

/** Encrypt bytes with a key. Output is base64 of iv || tag || ciphertext. */
function seal(plaintext: Buffer, key: Buffer): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ciphertext]).toString('base64')
}

function open_(sealed: string, key: Buffer): Buffer {
  const buf = Buffer.from(sealed, 'base64')
  if (buf.length < IV_BYTES + TAG_BYTES) {
    throw new Error('Ciphertext is malformed.')
  }
  const iv = buf.subarray(0, IV_BYTES)
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/** Mint a new per-contact data key, returned raw and wrapped. */
export function createContactKey(): { dataKey: Buffer; wrappedKey: string } {
  const dataKey = randomBytes(KEY_BYTES)
  return { dataKey, wrappedKey: seal(dataKey, masterKey()) }
}

export function unwrapContactKey(wrappedKey: string): Buffer {
  const dataKey = open_(wrappedKey, masterKey())
  if (dataKey.length !== KEY_BYTES) {
    throw new Error('Unwrapped contact key has the wrong length.')
  }
  return dataKey
}

export function encryptEntry(plaintext: string, dataKey: Buffer): string {
  return seal(Buffer.from(plaintext, 'utf8'), dataKey)
}

export function decryptEntry(sealed: string, dataKey: Buffer): string {
  return open_(sealed, dataKey).toString('utf8')
}

/**
 * Word count is stored in the clear so admin screens can show engagement
 * without the words. Computed here so the definition never drifts.
 */
export function countWords(plaintext: string): number {
  const trimmed = plaintext.trim()
  if (!trimmed) return 0
  return trimmed.split(/\s+/).length
}

/** Constant-time compare, for share tokens and verification tokens. */
export function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

export function newToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url')
}
