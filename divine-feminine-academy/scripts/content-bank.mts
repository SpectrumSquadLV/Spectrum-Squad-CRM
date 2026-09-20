/**
 * The content bank, as something readable on a phone.
 *
 * src/features/home/copy.ts is the source of truth - it is what the site
 * renders from - but nobody is going to browse a TypeScript file to find a
 * line for a TikTok. This writes the same data out as markdown, which GitHub
 * renders on a phone with no login.
 *
 * Generated, not written: a second hand-maintained copy of eighty lines would
 * be out of date within a week, and then there would be two versions of
 * Quiana's words and no way to tell which one was right.
 *
 * Run: npm run content-bank
 */
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pain, painClose } from '../src/features/home/copy'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '..', 'docs', 'content-bank.md')

const total = pain.reduce((n, block) => n + block.lines.length, 0)
const onHome = pain.reduce(
  (n, block) => n + block.lines.filter((l) => l.home).length,
  0,
)

let md = `# The content bank

Every behaviour, in Quiana's words. **${total} lines**, of which **${onHome}**
are on the home page.

A line marked **·** is one of the ones currently on the site. The rest are
here to be used: TikTok, podcast episodes, emails, challenge pages, ads. Any
one of them is an episode of Brown Girls Need Healing Too on its own.

Behaviours only — no explanation, no diagnosis. She has to recognise herself
before anybody tells her what it means.

> Generated from \`src/features/home/copy.ts\` by \`npm run content-bank\`.
> Edit the copy there, not here, and re-run it.

`

for (const block of pain) {
  md += `\n## ${block.word.toUpperCase()}\n\n`
  for (const line of block.lines) {
    md += `${line.home ? '· ' : ''}${line.text}\n\n`
  }
}

md += `\n---\n\n**${painClose}**\n\nThat is where the pain section stops, and where the reframe begins:\n\n> You don't have a wanting problem.\n> You have a pattern problem.\n\n> You know what you want.\n> The question is: who keeps showing up to create it?\n`

await writeFile(out, md, 'utf8')
console.log(`wrote ${out} — ${total} lines, ${onHome} on the home page`)
