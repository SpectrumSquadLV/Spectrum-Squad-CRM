/**
 * Colour contrast of the design tokens.
 *
 * The axe audit found two tokens below WCAG AA. Fixing them once is not
 * enough — the next tweak to a colour could put them back. This checks the
 * actual token values against the surfaces they are used on, so a regression
 * fails here rather than in front of a woman who cannot read the page.
 *
 * Run: npm run verify:contrast
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8')

/** Read a token straight out of the stylesheet, so this cannot drift. */
function token(name: string): string {
  const match = css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`))
  if (!match?.[1]) throw new Error(`token --color-${name} not found`)
  return match[1]
}

function channel(value: number): number {
  const c = value / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * (n & 255 ? channel(n & 255) : channel(0))
  )
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

/** A token at low opacity over a background, the way the UI actually renders. */
function blend(fg: string, bg: string, alpha: number): string {
  const f = parseInt(fg.slice(1), 16)
  const b = parseInt(bg.slice(1), 16)
  const mix = (shift: number) =>
    Math.round(
      (((f >> shift) & 255) * alpha + ((b >> shift) & 255) * (1 - alpha)),
    )
  return `#${[16, 8, 0].map((s) => mix(s).toString(16).padStart(2, '0')).join('')}`
}

let passed = 0
const failures: string[] = []

function check(label: string, fg: string, bg: string, minimum: number) {
  const ratio = contrast(fg, bg)
  if (ratio >= minimum) {
    passed++
    console.log(`  ok   ${label} — ${ratio.toFixed(2)}:1`)
  } else {
    failures.push(
      `${label} — ${ratio.toFixed(2)}:1 (needs ${minimum}:1) fg ${fg} on ${bg}`,
    )
    console.log(`  FAIL ${label} — ${ratio.toFixed(2)}:1, needs ${minimum}:1`)
  }
}

const bone = token('bone')
const alabaster = token('alabaster')
const linen = token('linen')
const ink = token('ink')

// 4.5:1 for body text, 3:1 for large text and non-text marks.
const BODY = 4.5
const LARGE = 3

console.log('text on the page background:')
for (const name of ['ink', 'ink-soft', 'ink-muted', 'ink-faint']) {
  check(`${name} on bone`, token(name), bone, BODY)
}

console.log('\ntext on raised and sunken surfaces:')
for (const name of ['ink', 'ink-soft', 'ink-muted', 'ink-faint']) {
  check(`${name} on alabaster`, token(name), alabaster, BODY)
}
check('ink-muted on linen', token('ink-muted'), linen, BODY)

/*
 * THE DARK SCENES.
 *
 * Day 1's REFLECTION turns the whole page near-black and sets every piece of
 * type on it as bone at some opacity. An opacity is not a token, so nothing
 * in this file would ever have looked at it - which is exactly how a screen
 * ends up shipping with 4:1 labels that nobody can read in daylight.
 *
 * Compositing is done here rather than eyeballed: bone at x% over plum-deep
 * is a real colour and it either passes or it does not.
 */
function over(fg: string, bg: string, alpha: number): string {
  const f = parseInt(fg.slice(1), 16)
  const b = parseInt(bg.slice(1), 16)
  const mix = (shift: number) => {
    const a = (f >> shift) & 255
    const c = (b >> shift) & 255
    return Math.round(a * alpha + c * (1 - alpha))
  }
  return (
    '#' +
    [16, 8, 0]
      .map((shift) => mix(shift).toString(16).padStart(2, '0'))
      .join('')
  )
}

const plumDeep = token('plum-deep')

for (const [name, alpha] of [
  ['muted type', 0.6],
  ['body type', 0.75],
  ['her handwriting', 0.7],
] as const) {
  check(
    `bone at ${alpha * 100}% (${name}) on plum-deep`,
    over(bone, plumDeep, alpha),
    plumDeep,
    BODY,
  )
}

check('bone on plum-deep', bone, plumDeep, BODY)

/*
 * HER's ground.
 *
 * The warm surface Day 5 and Day 7 open onto. It is lighter than bone, which
 * makes it the least forgiving background in the system for muted type - and
 * it carries the largest, most important copy in the challenge.
 */
const champagne = token('champagne')
for (const name of ['ink', 'ink-soft', 'ink-muted', 'clay-deep', 'plum'] as const) {
  check(`${name} on champagne`, token(name), champagne, BODY)
}

console.log('\naccents used as text:')
check('clay-deep on bone', token('clay-deep'), bone, BODY)
check('clay-deep on alabaster', token('clay-deep'), alabaster, BODY)
check('plum on bone', token('plum'), bone, BODY)
check('plum on plum-wash', token('plum'), token('plum-wash'), BODY)
check('positive on bone', token('positive'), bone, BODY)
check('critical on bone', token('critical'), bone, BODY)

console.log('\nfeedback text on its own 5% wash:')
check('caution on caution/5', token('caution'), blend(token('caution'), bone, 0.05), BODY)
check(
  'critical on critical-wash',
  token('critical'),
  token('critical-wash'),
  BODY,
)

/*
 * These render as 12px TEXT inside a badge, so the 4.5:1 body threshold
 * applies. An earlier version of this file used 3:1 on the grounds that they
 * were decorative marks; the browser audit disagreed, and it was right.
 */
console.log('\nthe four areas, used as 12px text on their own 5% wash:')
for (const area of [
  'area-herself',
  'area-relationships',
  'area-money',
  'area-success',
]) {
  check(`${area} on its wash`, token(area), blend(token(area), bone, 0.05), BODY)
}

console.log('\naccents inside a tinted callout:')
check(
  'clay-deep on the caution wash',
  token('clay-deep'),
  blend(token('caution'), bone, 0.05),
  BODY,
)
check(
  'caution on the critical wash',
  token('caution'),
  token('critical-wash'),
  BODY,
)

console.log('\nbuttons:')
check('bone on plum (primary button)', bone, token('plum'), BODY)
check('bone on plum-deep (primary hover)', bone, token('plum-deep'), BODY)
check('ink on alabaster (secondary button)', ink, alabaster, BODY)

console.log('\nthe focus ring must be visible against every surface:')
for (const [name, surface] of [
  ['bone', bone],
  ['alabaster', alabaster],
  ['linen', linen],
] as const) {
  check(`plum focus ring on ${name}`, token('plum'), surface, LARGE)
}

console.log()
if (failures.length > 0) {
  console.log(`contrast: ${failures.length} FAILED of ${passed + failures.length}`)
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}

assert.ok(passed > 0)
console.log(`contrast: all ${passed} checks passed`)
