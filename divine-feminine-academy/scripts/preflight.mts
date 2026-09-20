/**
 * Preflight. Run before a deploy, and after one.
 *
 *   npm run preflight
 *
 * Validates the environment, then makes live checks that only a running
 * database can answer: does it connect, are the migrations applied, is there
 * anything published.
 *
 * Exits non-zero on any error, so it can gate a deploy.
 */
import { readdirSync } from 'node:fs'
import { runPreflight, type CheckResult } from '../src/lib/config/preflight'

const RESET = '\x1b[0m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const GREEN = '\x1b[32m'
const DIM = '\x1b[2m'

function line(result: CheckResult) {
  const mark =
    result.severity === 'error'
      ? `${RED}  ✗${RESET}`
      : result.severity === 'warning'
        ? `${YELLOW}  !${RESET}`
        : `${GREEN}  ✓${RESET}`
  console.log(`${mark} ${result.key.padEnd(30)} ${DIM}${result.message}${RESET}`)
}

const report = runPreflight(process.env)

console.log(`\nPreflight — ${report.environment}\n`)
console.log('Environment:')
for (const result of report.results) line(result)

// --- Live checks -----------------------------------------------------------
const live: CheckResult[] = []

if (process.env.DATABASE_URL) {
  try {
    const { db } = await import('../src/db/client')
    const { sql } = await import('drizzle-orm')

    await db.execute(sql`select 1`)
    live.push({ key: 'database', severity: 'ok', message: 'Connects.' })

    // Migrations: compare what is on disk with what Drizzle recorded.
    const onDisk = readdirSync(
      new URL('../src/db/migrations', import.meta.url),
    ).filter((f) => f.endsWith('.sql')).length

    try {
      const applied = await db.execute(
        sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
      )
      const rows = applied as unknown as Array<{ n: number }>
      const count = Number(rows[0]?.n ?? 0)

      live.push({
        key: 'migrations',
        severity: count >= onDisk ? 'ok' : 'error',
        message:
          count >= onDisk
            ? `${count} applied, ${onDisk} on disk.`
            : `Only ${count} applied but ${onDisk} on disk. Run: npm run db:migrate`,
      })
    } catch {
      live.push({
        key: 'migrations',
        severity: 'error',
        message: `No migration history found. Run: npm run db:migrate (${onDisk} to apply)`,
      })
    }

    // The RLS migration defines policies that call auth.uid(). Supabase
    // provides it; a plain Postgres does not, and the policies would fail.
    try {
      await db.execute(sql`select auth.uid()`)
      live.push({ key: 'auth.uid()', severity: 'ok', message: 'Available.' })
    } catch {
      live.push({
        key: 'auth.uid()',
        severity: 'warning',
        message:
          'Not available. Row-level security policies depend on it — expected on Supabase, absent on a plain Postgres.',
      })
    }

    // Content: worth knowing, never fatal.
    try {
      const published = await db.execute(
        sql`select count(*)::int as n from programs where status = 'published'`,
      )
      const rows = published as unknown as Array<{ n: number }>
      const n = Number(rows[0]?.n ?? 0)
      live.push({
        key: 'published programs',
        severity: n > 0 ? 'ok' : 'warning',
        message:
          n > 0 ? `${n}.` : 'None. Run: npm run seed:challenge, then publish one.',
      })

      const offers = await db.execute(
        sql`select count(*)::int as n from offers where status = 'active'`,
      )
      const offerRows = offers as unknown as Array<{ n: number }>
      const activeOffers = Number(offerRows[0]?.n ?? 0)
      live.push({
        key: 'active offers',
        severity: 'ok',
        message:
          activeOffers > 0
            ? `${activeOffers}. Checkout is live.`
            : 'None, so nothing is purchasable. Deliberate until you pick a price.',
      })
    } catch {
      live.push({
        key: 'content',
        severity: 'warning',
        message: 'Could not read programs — migrations may not be applied.',
      })
    }
  } catch (error) {
    live.push({
      key: 'database',
      severity: 'error',
      message: `Will not connect: ${
        error instanceof Error ? error.message.split('\n')[0] : 'unknown error'
      }`,
    })
  }
}

if (live.length > 0) {
  console.log('\nLive:')
  for (const result of live) line(result)
}

const allErrors = [...report.errors, ...live.filter((r) => r.severity === 'error')]
const allWarnings = [
  ...report.warnings,
  ...live.filter((r) => r.severity === 'warning'),
]

console.log()
if (allErrors.length > 0) {
  console.log(
    `${RED}${allErrors.length} error(s)${RESET}, ${allWarnings.length} warning(s). This deployment is not ready.`,
  )
  process.exit(1)
}

console.log(
  `${GREEN}No errors${RESET}, ${allWarnings.length} warning(s).${
    allWarnings.length > 0 ? ' Read them — most are things you have not decided yet.' : ''
  }`,
)
process.exit(0)
