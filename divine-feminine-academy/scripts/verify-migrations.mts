/**
 * Every migration is actually registered.
 *
 * drizzle-kit does not run the .sql files in the migrations folder. It runs
 * the ones listed in meta/_journal.json, and a hand-written migration that
 * nobody adds to that file is SILENTLY SKIPPED — no error, no warning, and a
 * green `db:migrate` step.
 *
 * That is not hypothetical. Migrations 0012 and 0013 were written, committed,
 * deployed and reported as applied while sitting unregistered in that folder.
 * What found it was Postgres refusing an insert four steps later, in a
 * different suite, with an error about an enum value. A deploy had already
 * gone out.
 *
 * So: the folder and the journal must agree, exactly and in order.
 *
 * Run: npm run verify:migrations
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(import.meta.dirname, '..', 'src', 'db', 'migrations')

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

const files = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .map((f) => f.replace(/\.sql$/, ''))
  .sort()

const journal = JSON.parse(
  readFileSync(join(dir, 'meta', '_journal.json'), 'utf8'),
) as { entries: Array<{ idx: number; tag: string }> }

const tags = journal.entries.map((e) => e.tag)

console.log('\nmigrations')

for (const file of files) {
  check(`${file} is in the journal`, tags.includes(file))
}

for (const tag of tags) {
  check(`${tag} has a file`, files.includes(tag))
}

check(
  'the journal is in file order',
  JSON.stringify(tags) === JSON.stringify([...tags].sort()),
  tags.join(', '),
)

check(
  'the journal indexes are sequential from zero',
  journal.entries.every((e, i) => e.idx === i),
  journal.entries.map((e) => e.idx).join(','),
)

console.log(`\nmigrations: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
