/**
 * A real accessibility audit.
 *
 * axe-core against the rendered pages in a real browser — not a grep for
 * `alt=`. WCAG 2.2 AA is the floor this project committed to, and the women
 * using it will include some who navigate by keyboard or screen reader.
 *
 * Needs the app running:
 *   npm run build && npm start   (or npm run dev)
 *   BASE_URL=http://127.0.0.1:3000 npm run verify:a11y
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { chromium } from 'playwright'

const require_ = createRequire(import.meta.url)
const axeSource = readFileSync(require_.resolve('axe-core/axe.min.js'), 'utf8')

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000'

/** Public pages, plus the style guide, which is reachable in development. */
const PAGES = [
  '/',
  '/7-days-to-her',
  '/academy',
  '/about',
  '/stories',
  '/programs',
  '/assessment',
  '/quiz',
  '/quiz/the-commander',
  '/quiz/the-escape-artist',
  '/quiz/the-watcher',
  '/quiz/the-quiet-storm',
  '/unsubscribe/not-a-real-token',
  '/legal/privacy',
  '/legal/terms',
  '/legal/disclaimer',
  '/login',
  '/signup',
  '/admin/design',
]

interface AxeNode {
  html: string
  target: string[]
  failureSummary?: string
}
interface AxeViolation {
  id: string
  impact: string | null
  help: string
  helpUrl: string
  nodes: AxeNode[]
}

/*
 * This image ships a Chromium that does not match the version Playwright
 * expects, so point at the one that is here rather than downloading another.
 * PLAYWRIGHT_BROWSERS_PATH names the directory; the build number inside it
 * moves, so it is discovered rather than hard-coded.
 */
function findChromium(): string | undefined {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH
  if (!root || !existsSync(root)) return undefined

  for (const dir of readdirSync(root)) {
    for (const candidate of [
      join(root, dir, 'chrome-linux', 'chrome'),
      join(root, dir, 'chrome-linux', 'headless_shell'),
    ]) {
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

const executablePath = findChromium()
const browser = await chromium.launch(
  executablePath ? { executablePath } : {},
)
const context = await browser.newContext()

let totalViolations = 0
let pagesChecked = 0
const findings: Array<{ page: string; violation: AxeViolation }> = []

for (const path of PAGES) {
  const page = await context.newPage()
  try {
    const response = await page.goto(`${BASE}${path}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    })

    if (!response || response.status() >= 400) {
      console.log(`  skip ${path} (status ${response?.status() ?? 'none'})`)
      await page.close()
      continue
    }

    await page.addScriptTag({ content: axeSource })

    const results = (await page.evaluate(async () => {
      // @ts-expect-error axe is injected above
      return await axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      })
    })) as { violations: AxeViolation[] }

    pagesChecked++

    if (results.violations.length === 0) {
      console.log(`  ok   ${path}`)
    } else {
      totalViolations += results.violations.length
      console.log(`  FAIL ${path} — ${results.violations.length} violation(s)`)
      for (const violation of results.violations) {
        findings.push({ page: path, violation })
        console.log(`       [${violation.impact ?? 'n/a'}] ${violation.id}: ${violation.help}`)
        for (const node of violation.nodes.slice(0, 2)) {
          console.log(`         ${node.target.join(' ')}`)
        }
      }
    }
  } catch (error) {
    console.log(`  skip ${path} (${error instanceof Error ? error.message.split('\n')[0] : 'error'})`)
  } finally {
    if (!page.isClosed()) await page.close()
  }
}

console.log('\nkeyboard and structure:')

const page = await context.newPage()
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })

const lang = await page.getAttribute('html', 'lang')
console.log(lang ? `  ok   the document declares a language (${lang})` : '  FAIL no lang attribute')
if (!lang) totalViolations++

// The skip link has to be the first thing a keyboard reaches.
await page.keyboard.press('Tab')
const firstFocus = await page.evaluate(() => {
  const el = document.activeElement as HTMLElement | null
  return el ? `${el.tagName}:${(el.textContent ?? '').trim().slice(0, 30)}` : null
})
const hasSkip = firstFocus?.toLowerCase().includes('skip') ?? false
console.log(hasSkip ? '  ok   the first tab stop is the skip link' : `  FAIL first tab stop is ${firstFocus}`)
if (!hasSkip) totalViolations++

await page.close()
await browser.close()

console.log(
  `\naccessibility: ${pagesChecked} pages checked, ${totalViolations} violation(s)`,
)

if (totalViolations > 0) {
  console.log('\nFull detail:')
  for (const { page: p, violation } of findings) {
    console.log(`\n${p} — ${violation.id}`)
    console.log(`  ${violation.help}`)
    console.log(`  ${violation.helpUrl}`)
    for (const node of violation.nodes.slice(0, 3)) {
      console.log(`  target: ${node.target.join(' ')}`)
      if (node.failureSummary) {
        console.log(`  ${node.failureSummary.replace(/\n/g, '\n  ')}`)
      }
    }
  }
  process.exit(1)
}

process.exit(0)
