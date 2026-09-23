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

console.log('\nnothing builds a redirect from the internal address')

/*
 * The source-level half of this check.
 *
 * `new URL(request.url).origin` reads the address the CONTAINER was reached
 * on. Behind Railway's proxy that is localhost:$PORT, whatever the browser
 * typed. Using it for a redirect signs a woman in correctly and then sends
 * her to a host that does not exist - which is indistinguishable, from the
 * outside, from a login that is simply broken.
 *
 * Reading searchParams off request.url is fine and common; it is `.origin`
 * that lies. So this looks for that specifically.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(full)) out.push(full)
  }
  return out
}

const root = join(import.meta.dirname, '..')
const offenders: string[] = []
for (const file of [...walk(join(root, 'app')), ...walk(join(root, 'src'))]) {
  // Comments explain this very bug in at least one file, so strip them
  // before scanning or the guard trips on the note warning about it.
  const text = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  // Destructured `const { origin } = new URL(request.url)` or `.url).origin`.
  if (
    /new URL\((?:request|req)\.url\)\.origin/.test(text) ||
    /const \{[^}]*\borigin\b[^}]*\} = new URL\((?:request|req)\.url\)/.test(text)
  ) {
    offenders.push(file.replace(root + '/', ''))
  }
}

check('no route builds a redirect from request.url origin', () => {
  assert.deepEqual(offenders, [], offenders.join(', '))
})

console.log(`\norigin: all ${passed} checks passed`)
process.exit(0)
