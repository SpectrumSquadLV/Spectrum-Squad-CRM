/**
 * Make an empty database usable, once.
 *
 * Runs on every deploy and does nothing on almost all of them. A fresh
 * database needs its content seeded before the site is anything but empty
 * pages, and on a host where nobody can open a shell against the database,
 * the deploy itself is the only place that can do it.
 *
 * SAFE TO RUN REPEATEDLY, which is the whole design. Each step asks whether
 * its work is already done and skips if so — because `seed:challenge`
 * publishes a NEW programme version every time it runs, and a deploy hook that
 * called it unconditionally would stack up a version per deploy and quietly
 * move women mid-challenge onto content they never started.
 *
 * Seeds are spawned as child processes rather than imported: each one ends in
 * `process.exit`, which inside this process would take the rest of the
 * bootstrap with it.
 *
 * Run: DATABASE_URL=... npm run bootstrap
 */
import { spawnSync } from 'node:child_process'
import { sql } from 'drizzle-orm'
import { db } from '../src/db/client'

async function has(query: string): Promise<boolean> {
  try {
    const rows = await db.execute(sql.raw(query))
    // postgres-js returns an array-like; any row at all means "already there".
    return Array.isArray(rows) ? rows.length > 0 : Boolean(rows)
  } catch {
    // A missing table means the migration has not run, which means nothing is
    // seeded either. Treat it as absent rather than crashing the deploy.
    return false
  }
}

function run(script: string): boolean {
  console.log(`  running ${script}`)
  const result = spawnSync('npm', ['run', script], {
    stdio: 'inherit',
    env: process.env,
  })
  if (result.status !== 0) {
    console.error(`  ${script} FAILED with status ${result.status}`)
    return false
  }
  return true
}

interface Step {
  name: string
  /** When this returns true, the step is already done. */
  existing: string
  script: string
  /** A failure here should not stop the deploy. */
  optional?: boolean
  /**
   * Run every time, existence check ignored.
   *
   * Only for a seed that decides for itself whether it has work - the
   * photographs one compares file hashes and writes nothing when they match.
   * Everything else here publishes a new version when it runs, so running it
   * twice would move women mid-challenge onto content they never started.
   */
  always?: boolean
}

const steps: Step[] = [
  {
    name: 'ME VS HER and the CRM stages',
    /*
     * Asks whether the APPROVED curriculum is published, not merely whether
     * a programme row exists.
     *
     * "Does me-vs-her exist" was the check, and it was the wrong question the
     * moment the curriculum changed: the programme had existed since the
     * placeholder days, so every deploy skipped this step and the real seven
     * days would never have reached production. Nothing would have looked
     * broken - the site would simply have gone on serving MEET YOUR PROTECTOR
     * to women who were promised SEE ME.
     *
     * Day 1's title is the marker. Re-seeding publishes a NEW version and
     * leaves anybody mid-challenge on the one she started, so this is safe to
     * trip.
     */
    existing: `
      select 1
      from modules m
      join program_versions pv on pv.id = m.version_id
      join programs p on p.id = pv.program_id
      where p.slug = 'me-vs-her' and m.title = 'SEE ME'
      limit 1`,
    script: 'seed:challenge',
  },
  {
    name: 'the full course and the $11 offer',
    existing: `select 1 from offers where name = 'ME VS HER — the 7-day challenge' limit 1`,
    script: 'seed:offers',
  },
  {
    name: 'the assessment',
    existing: `select 1 from assessments where slug = 'where-are-you' limit 1`,
    script: 'seed:assessment',
    optional: true,
  },
  {
    name: 'the archetype quiz',
    /*
     * Same problem, same shape. The quiz has existed since it was built, so
     * "does it exist" would have skipped the two money questions that make
     * MONEY a reachable area at all - and the re-audited area weights with
     * them. A published version with fewer than fourteen questions is the
     * old instrument.
     */
    existing: `
      select 1
      from assessment_questions q
      join assessment_versions v on v.id = q.version_id
      join assessments a on a.id = v.assessment_id
      where a.slug = 'which-version'
      group by v.id
      having count(*) >= 14
      limit 1`,
    script: 'seed:quiz',
  },
  {
    name: 'the four email sequences',
    existing: `select 1 from automation_rules where trigger_event = 'archetype.assigned' limit 1`,
    script: 'seed:sequences',
  },
  {
    name: 'the example writing',
    existing: `select 1 from articles limit 1`,
    script: 'seed:writing',
    optional: true,
  },
  {
    name: 'the photographs committed to the repository',
    existing: `select 1 from site_images limit 1`,
    script: 'seed:images',
    always: true,
    optional: true,
  },
]

async function main() {
  console.log('\nbootstrap\n')

  let ran = 0
  let skipped = 0
  let failed = 0

  for (const step of steps) {
    if (!step.always && (await has(step.existing))) {
      console.log(`  skip  ${step.name} — already there`)
      skipped++
      continue
    }

    console.log(`  seed  ${step.name}`)
    if (run(step.script)) {
      ran++
    } else {
      failed++
      if (!step.optional) {
        console.error(`\nbootstrap failed on a required step: ${step.name}\n`)
        process.exit(1)
      }
    }
  }

  console.log(`\nbootstrap: ${ran} seeded, ${skipped} already there, ${failed} failed\n`)
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
