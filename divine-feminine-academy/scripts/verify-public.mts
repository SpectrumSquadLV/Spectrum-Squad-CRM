/**
 * What a stranger sees.
 *
 * The public site carries a lot of scaffolding: notes about copy Quiana has
 * not written, seeds that have not been run, a lawyer who has not reviewed the
 * terms, a price nobody has decided. All of it is useful and none of it is
 * for visitors - a dashed amber box saying "the bio is not written yet" on a
 * page somebody reached from a search for her name does more damage than the
 * missing bio ever could.
 *
 * So the rule is absolute: nothing marked as a build note may appear in the
 * HTML served to somebody who is not signed in as an admin. This file fetches
 * every public page anonymously and proves it, rather than trusting that the
 * component was used correctly on every page it was needed on.
 *
 * It checks the SERVED HTML, not the source. A server component that renders
 * a note for a guest fails here even if the code looks right, which is the
 * only kind of check worth having for something that fails silently.
 *
 * Run: BASE_URL=http://127.0.0.1:3100 npm run verify:public
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

/**
 * Serves the build itself unless pointed at something already running.
 *
 * Same approach as verify:noindex, and for the same reason: a check that
 * needs somebody to remember to start a server first is a check that gets
 * skipped in CI, and this is the one standing between a build note and a
 * stranger.
 */
async function serve(port: number): Promise<ChildProcess> {
  const child = spawn('npx', ['next', 'start', '-p', String(port)], {
    env: process.env,
    stdio: 'ignore',
  })

  for (let i = 0; i < 60; i++) {
    await sleep(500)
    try {
      if ((await fetch(`http://127.0.0.1:${port}/robots.txt`)).ok) return child
    } catch {
      // not up yet
    }
  }

  child.kill('SIGKILL')
  throw new Error(`the server never came up on port ${port}`)
}

const ownServer = process.env.BASE_URL ? null : await serve(4312)
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4312'

/** Everything a visitor can reach. */
const PUBLIC = [
  '/',
  '/the-divine-feminine',
  '/challenges',
  '/challenges/me-vs-her',
  '/podcast',
  '/about',
  '/writing',
  '/programs',
  '/quiz',
  '/quiz/the-commander',
  '/assessment',
  '/legal/privacy',
  '/legal/terms',
  '/legal/disclaimer',
  '/login',
  '/signup',
]

/** Pages that must NOT exist for a visitor at all. */
const HIDDEN = ['/stories']

/** Old addresses that have to keep working. */
const MOVED: Array<[from: string, to: string]> = [
  ['/me-vs-her', '/challenges/me-vs-her'],
  ['/listen', '/podcast'],
]

/**
 * Every marker that means "this is scaffolding".
 *
 * `data-staff-note` and `data-placeholder` are the attributes the two note
 * components carry, so a note reaching a guest is caught whatever it says.
 * The text patterns catch the other direction: a marker that arrived from the
 * database, from a seed, or from somebody writing one by hand in JSX.
 */
const FORBIDDEN: Array<[label: string, pattern: RegExp]> = [
  ['a staff-only note', /data-staff-note/],
  ['a build placeholder', /data-placeholder/],
  ['a seeded input marker', /NEEDS QUIANA/i],
  ['an ADMIN marker', /\[ADMIN[:\]]/i],
  ['a TODO', /\bTODO\b(?![^<]*<\/code>)/],
  ['lorem ipsum', /lorem ipsum/i],
]

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('\nwhat a stranger sees')

for (const path of PUBLIC) {
  const response = await fetch(`${BASE}${path}`, { redirect: 'manual' })

  if (response.status !== 200) {
    check(`${path} is reachable`, false, `status ${response.status}`)
    continue
  }

  const html = await response.text()
  const found = FORBIDDEN.filter(([, pattern]) => pattern.test(html))

  check(
    `${path} shows a visitor nothing unfinished`,
    found.length === 0,
    found.map(([label]) => label).join(', '),
  )
}

console.log('\nwhat a stranger must not find')

for (const path of HIDDEN) {
  const response = await fetch(`${BASE}${path}`, { redirect: 'manual' })
  check(
    `${path} is a 404 for a visitor`,
    response.status === 404,
    `status ${response.status} — an unpublished page that returns 200 gets indexed`,
  )
}

console.log('\nwhat moved')

for (const [from, to] of MOVED) {
  const response = await fetch(`${BASE}${from}`, { redirect: 'manual' })
  const location = response.headers.get('location') ?? ''
  check(
    `${from} still works, and goes to ${to}`,
    (response.status === 308 || response.status === 301) && location.endsWith(to),
    `status ${response.status}, location ${location || 'none'}`,
  )
}

console.log('\nthe feeds do not compete')

{
  const rss = await fetch(`${BASE}/writing/rss.xml`)
  const xml = await rss.text()
  check('the writing feed carries no iTunes tags', !/itunes:/i.test(xml))
  check('and no audio enclosures', !/<enclosure/i.test(xml))
  check(
    'it is still a valid-looking feed',
    xml.startsWith('<?xml') && xml.includes('<rss'),
  )
}

console.log('\nthe sitemap')

{
  const response = await fetch(`${BASE}/sitemap.xml`)
  const xml = await response.text()
  check('lists the Divine Feminine', xml.includes('/the-divine-feminine'))
  check('lists the challenges index', xml.includes('/challenges'))
  check('lists the podcast', xml.includes('/podcast'))
  check(
    'does NOT list the unpublished stories page',
    !xml.includes('/stories'),
    'listing an unpublished page is how a crawler finds one',
  )
  /*
   * The whole <loc>, not a suffix of one.
   *
   * The first version of this tested for '/me-vs-her<' and failed on
   * '/challenges/me-vs-her' — which is the URL the redirect points AT, and
   * exactly what should be listed. A suffix match cannot tell a moved address
   * from the one it moved to.
   */
  const locations = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) =>
    new URL(m[1]!).pathname,
  )
  const moved = locations.filter((path) => MOVED.some(([from]) => from === path))
  check(
    'does NOT list a moved URL',
    moved.length === 0,
    `${moved.join(', ')} — a redirect in a sitemap is crawl budget spent being told to go elsewhere`,
  )
}

ownServer?.kill('SIGTERM')

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed > 0 ? 1 : 0)
