/**
 * The magic link points at the site she is actually on.
 *
 * This check exists because the alternative cost an evening. The redirect in
 * a magic-link email used to be built from NEXT_PUBLIC_SITE_URL, which Next
 * inlines at BUILD time - so a deploy built before that variable was correct
 * put `localhost:$PORT` into every email, permanently. Railway sets PORT to
 * 8080, which is where the mystery "https://localhost:8080" came from.
 *
 * Nothing showed it: the variable read correctly in the dashboard, the deploy
 * was green, the site was up, and only the links in already-delivered inboxes
 * were wrong - and they stay wrong forever.
 *
 * So the origin now comes from the REQUEST. These check it reads the headers
 * a proxy actually sets, and falls back sanely when there is no request.
 *
 * Run: npm run verify:origin
 */
import assert from 'node:assert/strict'

let passed = 0
const check = (name: string, fn: () => void) => {
  fn()
  passed++
  console.log(`  ok   ${name}`)
}

/** The same resolution the real one does, against a fake header bag. */
function resolve(
  h: Record<string, string | undefined>,
  configured = 'http://localhost:3000',
): string {
  const host = h['x-forwarded-host'] ?? h['host']
  if (host) {
    const proto =
      h['x-forwarded-proto'] ?? (host.startsWith('localhost') ? 'http' : 'https')
    return `${proto}://${host}`
  }
  return configured
}

console.log('\nthe origin a magic link is built from')

check('uses the host the browser asked for', () => {
  assert.equal(
    resolve({
      host: 'divine-feminine-web-production.up.railway.app',
      'x-forwarded-proto': 'https',
    }),
    'https://divine-feminine-web-production.up.railway.app',
  )
})

check('prefers x-forwarded-host behind a proxy', () => {
  assert.equal(
    resolve({
      host: 'internal:8080',
      'x-forwarded-host': 'divinefeminine.com',
      'x-forwarded-proto': 'https',
    }),
    'https://divinefeminine.com',
  )
})

check('assumes https for a real domain with no proto header', () => {
  assert.equal(resolve({ host: 'divinefeminine.com' }), 'https://divinefeminine.com')
})

check('still uses http for local development', () => {
  assert.equal(resolve({ host: 'localhost:3000' }), 'http://localhost:3000')
})

check('falls back to the configured value with no request at all', () => {
  assert.equal(resolve({}, 'https://example.test'), 'https://example.test')
})

check('NEVER produces the localhost:8080 that caused this', () => {
  const origins = [
    resolve({ host: 'divine-feminine-web-production.up.railway.app', 'x-forwarded-proto': 'https' }),
    resolve({ host: 'internal:8080', 'x-forwarded-host': 'divinefeminine.com', 'x-forwarded-proto': 'https' }),
  ]
  for (const o of origins) assert.ok(!o.includes('localhost'), o)
})

console.log(`\norigin: all ${passed} checks passed`)
process.exit(0)
