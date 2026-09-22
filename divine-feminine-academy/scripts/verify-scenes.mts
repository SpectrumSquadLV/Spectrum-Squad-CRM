/**
 * A design system may not lose a word.
 *
 * Scenes change ground, scale, measure and rhythm. The one thing they must
 * never do is change what a woman reads - and the risk is real, because the
 * renderer now makes DECISIONS about paragraphs: it strips a trailing colon
 * from a label, splits a litany into list items, pulls a beat out at display
 * size. Every one of those is a chance to drop something.
 *
 * So this renders every rich_text block in the curriculum through the real
 * component and asserts the words that come out are the words that went in.
 * Not a snapshot - snapshots pass when both sides are wrong together - but
 * the source body compared against the rendered text.
 *
 * Run: npm run verify:scenes
 */
import assert from 'node:assert/strict'
import { createElement } from 'react'

// server.browser, and NOT through the registry.
//
// The registry pulls in every block type, several of which reach server-only
// modules, and the `react-server` condition that would satisfy those strips
// renderToStaticMarkup out of react-dom/server. Importing the one block under
// test directly keeps this script to the thing it is actually verifying.
const { renderToStaticMarkup } = await import('react-dom/server.browser')
const { days } = await import('../src/features/challenge/curriculum')
const { richText } = await import('../src/blocks/types/rich-text')
const { classify, paragraphs } = await import(
  '../src/blocks/types/rich-text/scene'
)
const { herLines, herLine } = await import('../src/features/challenge/her-voice')

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** Visible text, with markup and whitespace differences flattened away. */
function visible(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The same flattening, applied to the source, so the two are comparable. */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

const Member = richText.Member as (props: unknown) => unknown

console.log('every word survives its scene:')

let blocksChecked = 0

days.forEach((day, dayIndex) => {
  day.blocks.forEach((block, i) => {
    if (block.type !== 'rich_text') return
    const parsed = richText.configSchema.safeParse(block.config)
    if (!parsed.success) {
      check(`day ${dayIndex + 1} block ${i}: config parses`, false)
      return
    }
    const config = parsed.data as {
      body: string
      heading?: string
      herVoice?: string
    }

    // Placeholders stand for what she typed today. Filled with a marker so a
    // dropped placeholder is visible rather than silently empty on both sides.
    const today: Record<string, string> = {}
    for (const [, name] of config.body.matchAll(/\{\{(\w+)\}\}/g)) {
      today[name!] = `HER-OWN-WORDS-${name}`
    }

    const html = renderToStaticMarkup(
      createElement(Member as never, {
        blockId: 'verify',
        config,
        value: undefined,
        onChange: () => {},
        today,
      }) as never,
    )
    const out = visible(html)

    const source = config.body.replace(
      /\{\{(\w+)\}\}/g,
      (_, n: string) => today[n] ?? '',
    )

    // Every paragraph, in order, must appear in the output.
    let cursor = 0
    let missing: string | null = null
    for (const para of paragraphs(source)) {
      // A label's trailing colon is deliberately dropped by the renderer: the
      // typography frames her answer now, so the punctuation would be saying
      // it twice. That is the ONE permitted difference and it is asserted
      // here rather than tolerated by a loose comparison.
      const expected =
        classify(para) === 'label'
          ? flatten(para).replace(/:$/, '')
          : flatten(para)

      const at = out.indexOf(expected, cursor)
      if (at === -1) {
        missing = expected.slice(0, 60)
        break
      }
      cursor = at + expected.length
    }

    blocksChecked++
    check(
      `day ${dayIndex + 1} block ${i}${config.heading ? ` (${config.heading})` : ''}: intact, in order`,
      missing === null,
      missing ? `lost: "${missing}…"` : '',
    )

    if (config.heading) {
      check(
        `day ${dayIndex + 1} block ${i}: heading survives`,
        out.includes(flatten(config.heading)),
      )
    }

    if (config.herVoice) {
      const line = herLine(config.herVoice)
      check(
        `day ${dayIndex + 1} block ${i}: HER's line exists and renders`,
        Boolean(line) && out.includes(flatten(line!.text)),
      )
    }
  })
})

check('there were blocks to check at all', blocksChecked > 0, String(blocksChecked))

console.log('\nHER stays rare:')

const voiceUses = days.flatMap((d, i) =>
  d.blocks
    .filter((b) => (b.config as { herVoice?: string })?.herVoice)
    .map(() => i + 1),
)

// The scarcity is the mechanism, not a style preference: a hand that appears
// on every screen is a decorative font, and once it reads as decoration it
// can never be read as her again.
for (const day of new Set(voiceUses)) {
  const n = voiceUses.filter((d) => d === day).length
  check(`day ${day}: at most one line in her hand`, n <= 1, `${n} on this day`)
}

check(
  'every line she speaks is defined',
  days.every((d) =>
    d.blocks.every((b) => {
      const key = (b.config as { herVoice?: string })?.herVoice
      return !key || Boolean(herLine(key))
    }),
  ),
)

check(
  'and every line written is actually used',
  herLines.every((l) =>
    days.some((d) =>
      d.blocks.some((b) => (b.config as { herVoice?: string })?.herVoice === l.key),
    ),
  ),
)

console.log('\nthe classifier reads shape, not words:')

check('a line ending in a colon is a label', classify('THIS HAPPENED:') === 'label')
check('a short standalone line is a beat', classify("That's her.") === 'beat')
check(
  'three or more short lines are a litany',
  classify('She overthinks.\nShe shuts down.\nShe chases.') === 'litany',
)
check(
  'a long paragraph stays prose',
  classify(
    'ME has learned ways of moving through the world that, somewhere along the way, made sense to her.',
  ) === 'prose',
)
check(
  'two lines are not yet a litany',
  classify('She overthinks.\nShe shuts down.') === 'prose',
)

console.log(`\nscenes: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
