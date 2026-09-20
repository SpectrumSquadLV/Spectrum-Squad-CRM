/**
 * Round-trip check for journal encryption.
 *
 * Run: npm run verify:crypto
 *
 * This is the highest-stakes module in the codebase - if it is wrong, either
 * women's words leak or they become unreadable. Worth proving, not assuming.
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'

process.env.JOURNAL_MASTER_KEY ??= randomBytes(32).toString('base64')

const {
  countWords,
  createContactKey,
  decryptEntry,
  encryptEntry,
  newToken,
  tokensMatch,
  unwrapContactKey,
} = await import('../src/lib/crypto/journal')

const entry =
  'The first time I learned I was not worthy of love, I was nine years old.'

// 1. A wrapped key unwraps back to the same key.
const { dataKey, wrappedKey } = createContactKey()
assert.deepEqual(unwrapContactKey(wrappedKey), dataKey, 'key unwrap mismatch')

// 2. Ciphertext round-trips.
const sealed = encryptEntry(entry, dataKey)
assert.equal(decryptEntry(sealed, dataKey), entry, 'round-trip mismatch')

// 3. The stored value reveals nothing.
assert.ok(!sealed.includes('worthy'), 'plaintext leaked into ciphertext')
assert.ok(!sealed.includes('nine'), 'plaintext leaked into ciphertext')

// 4. The same text encrypts differently every time (fresh IV).
assert.notEqual(encryptEntry(entry, dataKey), sealed, 'IV is not random')

// 5. Another woman's key cannot read it.
const other = createContactKey()
assert.throws(
  () => decryptEntry(sealed, other.dataKey),
  'a different contact key decrypted the entry',
)

// 6. Tampering is detected (GCM auth tag).
const tampered = Buffer.from(sealed, 'base64')
const last = tampered.length - 1
tampered.writeUInt8(tampered.readUInt8(last) ^ 0xff, last)
assert.throws(
  () => decryptEntry(tampered.toString('base64'), dataKey),
  'tampered ciphertext was accepted',
)

// 7. Losing the master key makes entries permanently unreadable - by design.
process.env.JOURNAL_MASTER_KEY = randomBytes(32).toString('base64')
assert.throws(
  () => unwrapContactKey(wrappedKey),
  'a rotated master key still unwrapped the old contact key',
)

// 8. Metadata helpers.
assert.equal(countWords(entry), 16)
assert.equal(countWords('   '), 0)
assert.ok(tokensMatch('abc', 'abc'))
assert.ok(!tokensMatch('abc', 'abd'))
assert.ok(!tokensMatch('abc', 'abcd'))
assert.equal(newToken(24).length, 32)

console.log('journal encryption: all 8 checks passed')
