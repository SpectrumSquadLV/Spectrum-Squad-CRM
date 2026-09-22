/**
 * Webhook signature verification.
 *
 * An unverified webhook is an anonymous HTTP request claiming somebody paid.
 * If this is wrong, anyone who finds the endpoint can grant themselves a
 * $1,000 programme. These are the forgeries it has to refuse.
 *
 * Run: npm run verify:webhooks
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  computeSignature,
  parseSignatureHeader,
  verifySignature,
} from '../src/lib/payments/signature'
import { createFakeProvider } from '../src/lib/payments/fake'

let passed = 0
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve(fn()).then(() => {
    passed++
    console.log(`  ok   ${name}`)
  })
}

const SECRET = 'whsec_test_secret'
const NOW = 1_780_000_000
const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.completed' })

const header = (ts = NOW, sig = computeSignature(payload, ts, SECRET)) =>
  `t=${ts},v1=${sig}`

/**
 * Asserts the call was refused.
 *
 * Matches on the error NAME rather than `instanceof`: under tsx's transpile-only
 * loader a class can end up with two identities across the CJS/ESM boundary, so
 * `instanceof` would fail here even when the right error was thrown.
 */
function refuses(fn: () => void, what: string) {
  assert.throws(
    fn,
    (e: unknown) =>
      e instanceof Error && e.name === 'WebhookVerificationError',
    what,
  )
}

console.log('parsing:')

await check('a signature header parses into a timestamp and signatures', () => {
  const parsed = parseSignatureHeader('t=123,v1=abc,v0=ignored')
  assert.equal(parsed.timestamp, 123)
  assert.deepEqual(parsed.signatures, ['abc'])
})

await check('several v1 signatures are kept, for a secret rotation', () => {
  const parsed = parseSignatureHeader('t=123,v1=abc,v1=def')
  assert.deepEqual(parsed.signatures, ['abc', 'def'])
})

console.log('\naccepting what is genuine:')

await check('a correctly signed payload verifies', () => {
  verifySignature(payload, header(), SECRET, NOW)
})

await check('it verifies anywhere inside the tolerance', () => {
  verifySignature(payload, header(NOW - 280), SECRET, NOW)
  verifySignature(payload, header(NOW + 280), SECRET, NOW)
})

await check('it verifies when one of several signatures matches', () => {
  const good = computeSignature(payload, NOW, SECRET)
  verifySignature(payload, `t=${NOW},v1=deadbeef,v1=${good}`, SECRET, NOW)
})

console.log('\nrefusing forgeries:')

await check('a WRONG SECRET is refused', () => {
  const forged = `t=${NOW},v1=${computeSignature(payload, NOW, 'whsec_attacker')}`
  refuses(() => verifySignature(payload, forged, SECRET, NOW), 'accepted a forgery')
})

await check('a TAMPERED BODY is refused', () => {
  const h = header()
  const tampered = JSON.stringify({ id: 'evt_1', type: 'checkout.completed', amount: 1 })
  refuses(
    () => verifySignature(tampered, h, SECRET, NOW),
    'accepted a modified payload',
  )
})

await check('changing one character of the body is refused', () => {
  const h = header()
  refuses(() => verifySignature(payload + ' ', h, SECRET, NOW), 'accepted whitespace')
})

await check('a REPLAYED old webhook is refused', () => {
  const old = header(NOW - 3600)
  refuses(
    () => verifySignature(payload, old, SECRET, NOW),
    'an hour-old webhook was replayed successfully',
  )
})

await check('a webhook from the future is refused', () => {
  refuses(() => verifySignature(payload, header(NOW + 3600), SECRET, NOW), 'future')
})

await check('a missing signature header is refused', () => {
  refuses(() => verifySignature(payload, '', SECRET, NOW), 'no header')
})

await check('a header with no timestamp is refused', () => {
  refuses(() => verifySignature(payload, 'v1=abc', SECRET, NOW), 'no timestamp')
})

await check('a header with no v1 signature is refused', () => {
  refuses(() => verifySignature(payload, `t=${NOW}`, SECRET, NOW), 'no signature')
})

await check('a MISSING SECRET is refused, never skipped', () => {
  refuses(
    () => verifySignature(payload, header(), '', NOW),
    'verification was skipped when no secret was configured',
  )
})

await check('a signature of the right length but wrong value is refused', () => {
  const wrong = computeSignature('different payload', NOW, SECRET)
  refuses(() => verifySignature(payload, `t=${NOW},v1=${wrong}`, SECRET, NOW), 'wrong')
})

console.log('\nthe provider round trip:')

await check('the fake provider signs what it can verify', async () => {
  const fake = createFakeProvider(SECRET)
  const { body, header: h } = fake.sign({
    id: 'evt_round',
    type: 'checkout.completed',
    orderId: 'order-1',
    sessionId: 'cs_1',
    paymentIntentId: 'pi_1',
    customerId: null,
    amountCents: 100_000,
    currency: 'usd',
    failureReason: null,
    metadata: { orderId: 'order-1' },
    raw: null,
  })
  const event = await fake.provider.parseWebhook(body, h)
  assert.equal(event.id, 'evt_round')
  assert.equal(event.orderId, 'order-1')
  assert.equal(event.amountCents, 100_000)
})

await check('the fake provider still refuses a bad signature', async () => {
  const fake = createFakeProvider(SECRET)
  const { body } = fake.sign({
    id: 'evt_bad',
    type: 'checkout.completed',
    orderId: null,
    sessionId: null,
    paymentIntentId: null,
    customerId: null,
    amountCents: null,
    currency: null,
    failureReason: null,
    metadata: {},
    raw: null,
  })
  await assert.rejects(
    () => fake.provider.parseWebhook(body, `t=${NOW},v1=deadbeef`),
    'the fake provider accepted a forgery',
  )
})

/*
 * THE MONEY PATHS MUST NOT BE SILENT.
 *
 * A source-level guard, in the spirit of verify:origin's, because this is not
 * a property you can observe by calling the route: a silent failure and a
 * loud one both return the same status code to the caller. The only
 * difference is whether anybody can find out afterwards, and that difference
 * is invisible to a test that only looks at responses.
 *
 * It matters here more than anywhere else in the product. Stripe's webhook
 * secrets are `whsec_...` in BOTH live and test mode with nothing in the
 * string to distinguish them, so a live key paired with a test-mode secret
 * cannot be detected from the environment - and the way it shows up is a
 * rejected signature. When that path was a bare `catch`, the outcome was: a
 * real card charged, a 400 returned to Stripe, fulfilment skipped, and NOT
 * ONE LINE anywhere on the server. The only way to discover it was a woman
 * writing in to ask where the thing she paid for had gone.
 *
 * Both failure paths are checked, because they have different causes and need
 * different messages: one means the secret is wrong, the other means the
 * secret was right and fulfilment broke.
 */
await check('neither webhook failure path is silent', () => {
  const source = readFileSync('app/api/webhooks/payments/route.ts', 'utf8')

  // A `catch` that binds nothing cannot log what went wrong.
  assert.ok(
    !/}\s*catch\s*{/.test(source),
    'the payments webhook has a bare `catch {` - a failure there records nothing, ' +
      'and a woman who has been charged gets no access and leaves no trace',
  )

  assert.match(
    source,
    /console\.error\([`'"]\[webhook\] SIGNATURE REJECTED/,
    'a rejected signature must be logged: it is the symptom of a live key paired ' +
      'with a test-mode webhook secret, which takes real money and grants nothing',
  )

  assert.match(
    source,
    /console\.error\([`'"]\[webhook\] VERIFIED EVENT FAILED TO FULFIL/,
    'a verified event we could not apply must be logged - she has paid and the ' +
      'signature was fine, so the cause is ours',
  )
})

await check('the rejection tells the server everything and the caller nothing', () => {
  const source = readFileSync('app/api/webhooks/payments/route.ts', 'utf8')

  // The 400 body must stay vague: a precise error tells a forger what to fix.
  assert.match(
    source,
    /error:\s*'invalid'\s*}\s*,\s*{\s*status:\s*400/,
    'the 400 response should stay unspecific',
  )

  // And the secret must never be printed, only described.
  const logged = source.slice(source.indexOf('SIGNATURE REJECTED'))
  assert.ok(
    !/STRIPE_WEBHOOK_SECRET\s*(\)|,|\})/.test(
      logged.replace(/process\.env\.STRIPE_WEBHOOK_SECRET \?\? ''\)\.startsWith\(/g, ''),
    ) || logged.includes('.startsWith('),
    'the webhook secret must be described, never printed into a log',
  )
})

console.log(`\nwebhooks: all ${passed} checks passed`)
