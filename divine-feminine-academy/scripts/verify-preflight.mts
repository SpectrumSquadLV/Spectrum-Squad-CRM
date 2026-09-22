/**
 * Preflight.
 *
 * The point of this check is to turn silent misconfiguration into a loud
 * failure, so the rules that matter most are the ones about production: a
 * missing Resend key discards sign-in links, a missing webhook secret means
 * women pay and get nothing, and a fake payment provider hands out paid
 * programmes.
 *
 * Run: npm run verify:preflight
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import {
  checkDatabaseUrl,
  checkMasterKey,
  checkSiteUrl,
  runPreflight,
  type Env,
} from '../src/lib/config/preflight'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ok   ${name}`)
}

const goodKey = randomBytes(32).toString('base64')

/** A fully configured production environment. */
const production: Env = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://user:pw@db.example.com:5432/postgres',
  JOURNAL_MASTER_KEY: goodKey,
  NEXT_PUBLIC_SITE_URL: 'https://academy.example.com',
  NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
  RESEND_API_KEY: 'PLACEHOLDER-resend-key',
  EMAIL_FROM: 'Academy <hello@example.com>',
  STRIPE_SECRET_KEY: 'PLACEHOLDER-stripe-key',
  STRIPE_WEBHOOK_SECRET: 'PLACEHOLDER-webhook-secret',
  CRON_SECRET: 'PLACEHOLDER-cron-secret',
}

const errorKeys = (env: Env) => runPreflight(env).errors.map((e) => e.key)

console.log('the master key:')

check('a correct 32-byte key passes', () => {
  assert.equal(checkMasterKey(goodKey).severity, 'ok')
})

check('a missing key is an error', () => {
  assert.equal(checkMasterKey(undefined).severity, 'error')
  assert.equal(checkMasterKey('').severity, 'error')
})

check('a key of the wrong length is an error', () => {
  assert.equal(checkMasterKey(randomBytes(16).toString('base64')).severity, 'error')
  assert.equal(checkMasterKey(randomBytes(64).toString('base64')).severity, 'error')
})

check('a plausible-looking but wrong key is still caught', () => {
  const result = checkMasterKey('not-really-a-key')
  assert.equal(result.severity, 'error')
  assert.match(result.message, /32 bytes/)
})

console.log('\nthe database URL:')

check('a postgres URL passes', () => {
  assert.equal(checkDatabaseUrl('postgresql://u:p@h:5432/db').severity, 'ok')
  assert.equal(checkDatabaseUrl('postgres://u:p@h:5432/db').severity, 'ok')
})

check('something that is not a postgres URL is an error', () => {
  assert.equal(checkDatabaseUrl('mysql://u:p@h/db').severity, 'error')
  assert.equal(checkDatabaseUrl('db.example.com').severity, 'error')
  assert.equal(checkDatabaseUrl(undefined).severity, 'error')
})

console.log('\nthe site URL:')

check('https passes in production', () => {
  assert.equal(checkSiteUrl('https://a.example.com', true).severity, 'ok')
})

check('http is an ERROR in production', () => {
  const result = checkSiteUrl('http://a.example.com', true)
  assert.equal(result.severity, 'error')
  assert.match(result.message, /https/)
})

check('http is fine in development', () => {
  assert.equal(checkSiteUrl('http://localhost:3000', false).severity, 'ok')
})

check('a trailing slash is a warning, not a failure', () => {
  assert.equal(checkSiteUrl('https://a.example.com/', true).severity, 'warning')
})

check('missing is an error in production, a warning locally', () => {
  assert.equal(checkSiteUrl(undefined, true).severity, 'error')
  assert.equal(checkSiteUrl(undefined, false).severity, 'warning')
})

console.log('\na fully configured production deploy:')

check('passes with no errors', () => {
  const report = runPreflight(production)
  assert.equal(report.ok, true, `unexpected errors: ${errorKeys(production).join(', ')}`)
  assert.equal(report.environment, 'production')
})

console.log('\nthe failures that actually hurt:')

check('NO RESEND KEY in production is an error, not a warning', () => {
  const keys = errorKeys({ ...production, RESEND_API_KEY: undefined })
  assert.ok(
    keys.includes('RESEND_API_KEY'),
    'a deploy that silently discards sign-in links was allowed',
  )
})

check('Stripe configured WITHOUT its webhook secret is an error', () => {
  const keys = errorKeys({ ...production, STRIPE_WEBHOOK_SECRET: undefined })
  assert.ok(
    keys.includes('STRIPE_WEBHOOK_SECRET'),
    'women could pay and receive nothing',
  )
})

check('the FAKE payment provider is an error in production', () => {
  const keys = errorKeys({ ...production, PAYMENTS_PROVIDER: 'fake' })
  assert.ok(keys.includes('PAYMENTS_PROVIDER'), 'a provider that approves everything')
})

check('no CRON_SECRET in production is an error', () => {
  const keys = errorKeys({ ...production, CRON_SECRET: undefined })
  assert.ok(keys.includes('CRON_SECRET'), 'no reminder would ever send')
})

check('no Supabase keys in production is an error', () => {
  const keys = errorKeys({ ...production, NEXT_PUBLIC_SUPABASE_ANON_KEY: undefined })
  assert.ok(keys.includes('NEXT_PUBLIC_SUPABASE_ANON_KEY'))
})

console.log('\nbeing forgiving where it is safe to be:')

check('development tolerates almost everything', () => {
  const report = runPreflight({
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://localhost:5432/dfa',
    JOURNAL_MASTER_KEY: goodKey,
  })
  assert.equal(report.ok, true, 'local development was blocked by missing keys')
  assert.ok(report.warnings.length > 0, 'but it should still say what is missing')
})

check('but a broken master key fails even in development', () => {
  const report = runPreflight({
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://localhost:5432/dfa',
    JOURNAL_MASTER_KEY: 'too-short',
  })
  assert.equal(report.ok, false, 'a key that cannot decrypt anything was accepted')
})

check('no Stripe at all is only a warning — she is not selling yet', () => {
  const report = runPreflight({
    ...production,
    STRIPE_SECRET_KEY: undefined,
    STRIPE_WEBHOOK_SECRET: undefined,
  })
  assert.equal(report.ok, true, 'not selling yet should not block a deploy')
})

check('a Stripe TEST key in production BLOCKS the deploy', () => {
  /*
   * This assertion used to say "flagged but not fatal", on the reasoning
   * that a test key announces itself because real cards decline.
   *
   * That is backwards. The person who finds out is a woman at the checkout
   * being told her card was declined — she does not conclude "test mode",
   * she concludes her card was refused, and she leaves. Nothing appears in
   * any log, because nothing failed: Stripe did exactly what a test key
   * asks for. It is the most likely way to lose a sale on launch day and
   * the fix is one environment variable, so it gates the deploy.
   */
  // The prefix is what the rule looks at, so this one has to carry it. The
  // rest is deliberately unmistakable.
  const report = runPreflight({
    ...production,
    STRIPE_SECRET_KEY: 'sk_test_PLACEHOLDER_NOT_A_REAL_KEY',
  })
  assert.equal(report.ok, false, 'launching in test mode must not be deployable')
  assert.ok(
    report.errors.some((e) => e.key === 'STRIPE_SECRET_KEY'),
    'and it must say which variable is wrong',
  )
})

check('a LIVE key warns that the webhook secret must match its mode', () => {
  /*
   * The one failure nothing can detect. Stripe's webhook secrets are
   * `whsec_...` in both modes with nothing to tell them apart, so a live key
   * paired with a test-mode secret passes every check: her card is really
   * charged, the signature fails, fulfilment never runs, and she has paid
   * real money for nothing. Unverifiable, so it is said out loud.
   */
  const report = runPreflight({
    ...production,
    STRIPE_SECRET_KEY: 'sk_live_PLACEHOLDER_NOT_A_REAL_KEY',
  })
  assert.equal(report.ok, true, 'a live key is the correct state, not an error')
  assert.ok(
    report.warnings.some((w) => w.key === 'STRIPE_WEBHOOK_SECRET'),
    'going live without a word about the webhook mode is how she loses a real sale',
  )
})

check('an unused service role key is called out', () => {
  const report = runPreflight({ ...production, SUPABASE_SERVICE_ROLE_KEY: 'srv' })
  assert.ok(
    report.warnings.some((w) => w.key === 'SUPABASE_SERVICE_ROLE_KEY'),
    'a powerful unused key was left unmentioned',
  )
})

console.log(`\npreflight: all ${passed} checks passed`)
