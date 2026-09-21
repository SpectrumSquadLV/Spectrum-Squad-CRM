/**
 * Rate limiting.
 *
 * Run: npm run verify:rate-limit
 */
import assert from 'node:assert/strict'
import { LIMITS, rateLimit, resetRateLimits } from '../src/lib/security/rate-limit'

let passed = 0
function check(name: string, fn: () => void) {
  resetRateLimits()
  fn()
  passed++
  console.log(`  ok   ${name}`)
}

const NOW = 1_780_000_000_000

console.log('rate limiting:')

check('requests under the limit are allowed', () => {
  for (let i = 0; i < 5; i++) {
    assert.equal(rateLimit('k', 5, 60, NOW).allowed, true, `request ${i + 1}`)
  }
})

check('the request over the limit is refused', () => {
  for (let i = 0; i < 5; i++) rateLimit('k', 5, 60, NOW)
  const result = rateLimit('k', 5, 60, NOW)
  assert.equal(result.allowed, false)
  assert.ok(result.retryAfterSeconds > 0, 'no retry-after was given')
})

check('remaining counts down and floors at zero', () => {
  assert.equal(rateLimit('k', 3, 60, NOW).remaining, 2)
  assert.equal(rateLimit('k', 3, 60, NOW).remaining, 1)
  assert.equal(rateLimit('k', 3, 60, NOW).remaining, 0)
  assert.equal(rateLimit('k', 3, 60, NOW).remaining, 0)
})

check('the window resets', () => {
  for (let i = 0; i < 5; i++) rateLimit('k', 5, 60, NOW)
  assert.equal(rateLimit('k', 5, 60, NOW).allowed, false)
  assert.equal(rateLimit('k', 5, 60, NOW + 61_000).allowed, true, 'window did not reset')
})

check('different keys do not share a budget', () => {
  for (let i = 0; i < 5; i++) rateLimit('a', 5, 60, NOW)
  assert.equal(rateLimit('a', 5, 60, NOW).allowed, false)
  assert.equal(rateLimit('b', 5, 60, NOW).allowed, true, 'one address blocked another')
})

check('a limit of one allows exactly one', () => {
  assert.equal(rateLimit('k', 1, 60, NOW).allowed, true)
  assert.equal(rateLimit('k', 1, 60, NOW).allowed, false)
})

check('the configured auth limit is tight but not hostile', () => {
  const { limit, windowSeconds } = LIMITS.authRequest
  assert.ok(limit >= 3, 'a woman who mistypes her email once should not be locked out')
  assert.ok(limit <= 10, 'too loose to slow a script down')
  assert.ok(windowSeconds >= 300)
})

console.log(`\nrate limiting: all ${passed} checks passed`)
