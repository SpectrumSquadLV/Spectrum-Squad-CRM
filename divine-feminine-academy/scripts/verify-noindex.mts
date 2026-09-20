/**
 * The switch that keeps an unfinished site out of Google.
 *
 * SITE_NOINDEX is the only thing standing between a deployed preview - which
 * carries placeholder curriculum and crisis phone numbers nobody has confirmed
 * - and a search result. It was connected to nothing for a while, in a way no
 * test could have caught and nobody would have noticed: robots.txt and the
 * page metadata were both evaluated when the site was BUILT, so setting the
 * variable on the running service changed nothing at all.
 *
 * So this starts the built server twice, on two ports, with the variable set
 * and unset, and asks it. The build under test is whatever `npm run build`
 * last produced - and, deliberately, that build is not told about the
 * variable, because that is the arrangement that failed.
 *
 * It also checks the OFF state, which matters just as much: a site that
 * cannot be found after the switch is removed is the same outage in reverse.
 *
 * Run: npm run build && npm run verify:noindex
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function serve(
  port: number,
  env: Record<string, string>,
): Promise<ChildProcess> {
  const child = spawn('npx', ['next', 'start', '-p', String(port)], {
    env: { ...process.env, ...env },
    stdio: 'ignore',
  })

  for (let i = 0; i < 60; i++) {
    await sleep(500)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/robots.txt`)
      if (response.ok) return child
    } catch {
      // not up yet
    }
  }

  child.kill('SIGKILL')
  throw new Error(`the server never came up on port ${port}`)
}

/** Pages that are PRERENDERED are the ones the old approach could not reach. */
const pages = ['/', '/challenges/me-vs-her', '/legal/privacy', '/podcast', '/programs']

console.log('\nSITE_NOINDEX=1 — shut to crawlers')

const shut = await serve(4311, { SITE_NOINDEX: '1' })
try {
  const robots = await (await fetch('http://127.0.0.1:4311/robots.txt')).text()
  check('robots.txt disallows everything', /Disallow:\s*\/\s*$/m.test(robots.trim()), robots.replaceAll('\n', ' | '))
  check('and offers no sitemap', !robots.toLowerCase().includes('sitemap'))

  const sitemap = await (await fetch('http://127.0.0.1:4311/sitemap.xml')).text()
  check('the sitemap lists nothing', !sitemap.includes('<loc>'))

  for (const page of pages) {
    const response = await fetch(`http://127.0.0.1:4311${page}`)
    const header = response.headers.get('x-robots-tag') ?? ''
    check(`${page} carries the noindex header`, header.includes('noindex'), `"${header}"`)
  }

  const html = await (await fetch('http://127.0.0.1:4311/')).text()
  check('and a noindex meta tag as well', /<meta name="robots" content="noindex/.test(html))
} finally {
  shut.kill('SIGKILL')
}

console.log('\nwithout it — findable again')

const open = await serve(4312, { SITE_NOINDEX: '' })
try {
  const robots = await (await fetch('http://127.0.0.1:4312/robots.txt')).text()
  check('robots.txt allows the public site', robots.includes('Allow: /'))
  check('and still hides the private paths', robots.includes('/quiz/result') && robots.includes('/my-practice'))
  check('and points at a sitemap', robots.toLowerCase().includes('sitemap'))

  const sitemap = await (await fetch('http://127.0.0.1:4312/sitemap.xml')).text()
  check('which lists pages', sitemap.includes('<loc>'))

  for (const page of pages) {
    const response = await fetch(`http://127.0.0.1:4312${page}`)
    const header = response.headers.get('x-robots-tag') ?? ''
    check(`${page} is not held back`, !header.includes('noindex'), `"${header}"`)
  }

  const html = await (await fetch('http://127.0.0.1:4312/')).text()
  check('and carries no noindex meta tag', !/<meta name="robots" content="noindex/.test(html))
} finally {
  open.kill('SIGKILL')
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed > 0 ? 1 : 0)
