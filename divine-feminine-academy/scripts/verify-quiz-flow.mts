/**
 * The quiz, in a real browser, on a phone.
 *
 * The unit tests prove the scoring; the database tests prove what is stored.
 * Neither of them can tell you whether a woman can actually finish it with her
 * thumb — and finishing is the entire product. This drives the real flow at
 * 390px: twelve taps, the gate, the result, and the share link a stranger
 * arrives through.
 *
 * Two checks here are about the FUNNEL rather than the code, and both have
 * already caught something: that she is shown something true before the email
 * box, and that her archetype is not named anywhere on the page before she
 * gives it. The second one failed the first time this ran, because the four
 * were listed at the bottom of the quiz page — which both spoiled the reveal
 * and told her the answer before she had answered.
 *
 * Needs a built app running at BASE_URL (npm run build && npm run start) and a
 * database with the quiz seeded.
 *
 * Run: npm run verify:quiz-flow
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

/*
 * This image ships a Chromium that does not match the version Playwright
 * expects, so point at the one that is here rather than downloading another.
 */
function findChromium(): string | undefined {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH
  if (!root || !existsSync(root)) return undefined
  for (const dir of readdirSync(root)) {
    for (const c of [
      join(root, dir, 'chrome-linux', 'chrome'),
      join(root, dir, 'chrome-linux', 'headless_shell'),
    ]) {
      if (existsSync(c)) return c
    }
  }
  return undefined
}

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000'

const exe = findChromium()
const browser = await chromium.launch(exe ? { executablePath: exe } : {})
// A phone, because that is where she is.
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })

let fails = 0
const ok = (n: string, c: boolean, d = '') => {
  console.log(`  ${c ? 'ok  ' : 'FAIL'} ${n}${c ? '' : ' — ' + d}`)
  if (!c) fails++
}

await page.goto(`${BASE}/quiz`, { waitUntil: 'networkidle' })
ok('the quiz loads', await page.locator('h1').first().isVisible())
ok('it opens on question 1 of 12', (await page.getByText('1 of 12').count()) === 1)

// Tap the first option, twelve times.
for (let i = 1; i <= 12; i++) {
  const buttons = page.locator('button[aria-pressed]')
  await buttons.first().waitFor({ state: 'visible' })
  const before = await buttons.count()
  if (before !== 4) { ok(`question ${i} shows four options`, false, `${before}`); break }
  await buttons.nth(i % 4).click()
  await page.waitForTimeout(350)
}

ok('the email gate appears after the last question', await page.getByLabel('Email').isVisible())
ok('she is shown something true first', (await page.locator('blockquote').count()) === 1)
ok('the archetype is NOT named before the email', !(await page.locator('body').innerText()).includes('The Commander'))

const email = `flow-${Date.now()}@example.test`
await page.getByLabel('First name').fill('Ada')
await page.getByLabel('Email').fill(email)
await page.getByRole('button', { name: /show me who she is/i }).click()
await page.waitForURL(/\/quiz\/result\//, { timeout: 15000 })

ok('it lands on her result', /\/quiz\/result\/[A-Za-z0-9_-]{10,}/.test(page.url()), page.url())
const text = await page.locator('body').innerText()
ok('the result names one of the four', /The (Commander|Escape Artist|Watcher|Quiet Storm)/.test(text))
ok('the result shows what it is protecting', text.includes('What she is protecting'))
ok('the result shows the return', text.includes('The return') || text.includes('THE RETURN'))
ok('the result shows all four shares', text.includes('All four, as you answered'))
ok('the result offers the 7 days', (await page.getByRole('link', { name: /start the 7 days/i }).count()) === 1)
ok('the result offers a share link', (await page.getByRole('link', { name: /share this/i }).count()) === 1)
ok('the result carries the not-therapy line', text.toLowerCase().includes('not a diagnosis'))

// The share link must reach a real public page, not a redirect into the quiz.
await page.getByRole('link', { name: /share this/i }).click()
await page.waitForURL(/\/quiz\/the-/, { timeout: 15000 })
ok('the share link opens a public archetype page', /\/quiz\/the-/.test(page.url()), page.url())
ok('the public page invites the visitor to take it', (await page.getByRole('link', { name: /take the quiz/i }).count()) >= 1)

// The opt-in on the public page: she recognised herself and never took the
// quiz, which is the warmest lead on the site.
await page.goto(`${BASE}/quiz/the-watcher`, { waitUntil: 'networkidle' })
ok('the public page offers the emails', (await page.getByRole('button', { name: /send me the five emails/i }).count()) === 1)

await page.getByLabel('First name').fill('Dee')
await page.getByLabel('Email').fill(`flow-optin-${Date.now()}@example.test`)
await page.getByRole('button', { name: /send me the five emails/i }).click()
await page.getByText(/check your inbox/i).waitFor({ timeout: 15000 })

const optInText = await page.locator('body').innerText()
ok('she is told the first one is on its way', /on its way/i.test(optInText))
ok('she is told what the rest are', /four more/i.test(optInText))
ok('she is told unsubscribing is one click', /unsubscribe/i.test(optInText))
ok('she was not made to take the quiz first', !/1 of 12/.test(optInText))

// A bad unsubscribe link must not 500 or claim success.
await page.goto(`${BASE}/unsubscribe/not-a-real-token`, { waitUntil: 'networkidle' })
const unsubText = await page.locator('body').innerText()
ok('a broken unsubscribe link explains itself', /expired/i.test(unsubText))
ok('and does not claim she was unsubscribed', !/you are unsubscribed/i.test(unsubText))

// No horizontal scroll on a phone.
await page.goto(`${BASE}/quiz/the-watcher`, { waitUntil: 'networkidle' })
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
ok('no sideways scroll on a phone', !overflow)

await browser.close()
console.log(fails === 0 ? '\nquiz flow: all checks passed\n' : `\nquiz flow: ${fails} failed\n`)
process.exit(fails > 0 ? 1 : 0)
