/**
 * Connection-string handling.
 *
 * Supabase's transaction pooler does not support prepared statements, which
 * postgres-js uses by default. Against a pooled URL that means every query
 * fails — and the pooler is exactly what a serverless deploy wants, so this
 * would only have shown up in production.
 *
 * Run: npm run verify:db-url
 */
import assert from 'node:assert/strict'

/** Mirrors the detection in src/db/client.ts. */
function isPooled(url: string): boolean {
  return /(^|[:@.])6543(\/|$)/.test(url) || url.includes('pooler.supabase')
}

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ok   ${name}`)
}

console.log('detecting a pooled connection:')

check('the Supabase transaction pooler is detected by port', () => {
  assert.equal(
    isPooled('postgresql://postgres.abc:pw@aws-0-us-west-1.pooler.supabase.com:6543/postgres'),
    true,
  )
})

check('and by host, whatever the port', () => {
  assert.equal(
    isPooled('postgresql://postgres.abc:pw@aws-0-us-west-1.pooler.supabase.com:5432/postgres'),
    true,
  )
})

check('a direct connection is NOT treated as pooled', () => {
  assert.equal(
    isPooled('postgresql://postgres:pw@db.abcdefgh.supabase.co:5432/postgres'),
    false,
  )
})

check('a local database is not treated as pooled', () => {
  assert.equal(isPooled('postgresql://postgres@127.0.0.1:5432/dfa'), false)
  assert.equal(isPooled('postgres://localhost/dfa'), false)
})

check('a password containing 6543 does not trigger it', () => {
  assert.equal(
    isPooled('postgresql://postgres:p6543x@db.example.co:5432/postgres'),
    false,
    'a password was mistaken for a port',
  )
})

check('a database name containing 6543 does not trigger it', () => {
  assert.equal(
    isPooled('postgresql://postgres:pw@db.example.co:5432/app6543'),
    false,
    'a database name was mistaken for a port',
  )
})

console.log(`\nconnection strings: all ${passed} checks passed`)
