/**
 * ME VS. HER — the curriculum itself.
 *
 * Pure: no database, no clock, no network. It loads the curriculum module the
 * seed publishes and checks the things that would be silently wrong after a
 * hurried edit, and that nothing else would catch.
 *
 * The failures this is here for:
 *
 *  - A callback pointing at a name no screen saves under. The screen renders,
 *    the quote is simply missing, and Day 7 quietly stops showing her the
 *    decision she is deciding.
 *  - A mirror on Day 7, or the timers drifting off 1/2/2/3/3/3.
 *  - Academy content leaking into the challenge - a belief block, the
 *    manifestation loop, the retirement ceremony, RETURN.
 *  - A block collecting something painful without being marked sensitive,
 *    which is what decides whether her answer is encrypted before it reaches
 *    Postgres. Nothing would look broken.
 *  - Day 7 asking HER before ME, which inverts the whole method.
 *
 * Run: npm run verify:me-vs-her
 */
import { days } from '../src/features/challenge/curriculum'
import { getBlock } from '../src/blocks/registry'

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

const cfg = (b: { config: Record<string, unknown> }) => b.config
const typesOn = (day: number) => days[day - 1]!.blocks.map((b) => b.type)

console.log('\nthe shape of the week')

check('seven days', days.length === 7, String(days.length))
check(
  'the days are in the approved order',
  JSON.stringify(days.map((d) => d.title)) ===
    JSON.stringify([
      'SEE ME',
      'UNDERSTAND ME',
      'LOVE ME',
      'RECOGNIZE WHAT ME HAS BEEN CREATING',
      'MEET HER',
      'CHOOSE HER',
      'ME VS. HER',
    ]),
  days.map((d) => d.title).join(' / '),
)
check(
  'every block type is in the registry',
  days.every((d) => d.blocks.every((b) => getBlock(b.type))),
  days
    .flatMap((d) => d.blocks.map((b) => b.type))
    .filter((t) => !getBlock(t))
    .join(', '),
)

console.log('\nthe mirror')

const mirrors = days.map((d) =>
  d.blocks.filter((b) => b.type === 'mirror_gaze'),
)
check(
  'Days 1 to 6 each end at exactly one mirror',
  mirrors.slice(0, 6).every((m) => m.length === 1),
  mirrors.map((m) => m.length).join(','),
)
check('Day 7 has NO mirror', mirrors[6]!.length === 0)
check(
  'the timers climb 1, 2, 2, 3, 3, 3 minutes',
  JSON.stringify(
    mirrors.slice(0, 6).map((m) => (cfg(m[0]!) as { seconds: number }).seconds),
  ) === JSON.stringify([60, 120, 120, 180, 180, 180]),
)
check(
  'every mirror is silent — no intention held up during the timer',
  mirrors
    .slice(0, 6)
    .every((m) => !(cfg(m[0]!) as { intention?: string }).intention),
)
check(
  "Day 5's mirror is the lighter one",
  (cfg(mirrors[4]![0]!) as { mood?: string }).mood === 'open',
)
check(
  'every mirror is preceded by its own screen of setup copy',
  days.slice(0, 6).every((d) => {
    const i = d.blocks.findIndex((b) => b.type === 'mirror_gaze')
    return i > 0 && d.blocks[i - 1]!.type === 'rich_text'
  }),
)

console.log('\nthe scope guard')

/*
 * ME VS. HER creates awareness and the first identity shift. It does NOT
 * teach Academy content, and no belief is named anywhere in the seven days.
 */
const ACADEMY_ONLY = [
  'belief_review',
  'belief_origin',
  'manifestation_loop',
  'me_retirement',
  'her_code_builder',
  'return_practice',
  'evidence_review',
  'mirror_declaration',
]
check(
  'no Academy content anywhere in the seven days',
  days.every((d) => d.blocks.every((b) => !ACADEMY_ONLY.includes(b.type))),
  days
    .flatMap((d) => d.blocks.map((b) => b.type))
    .filter((t) => ACADEMY_ONLY.includes(t))
    .join(', '),
)
check(
  'the word RETURN never appears as a practice',
  !JSON.stringify(days).includes('return_practice'),
)

console.log('\nwhat she writes is encrypted')

/*
 * The one that matters most. isSensitive decides whether her answer is
 * encrypted before it reaches Postgres, and a block that collects her
 * earliest memory without it would store that in the clear.
 */
for (const [i, day] of days.entries()) {
  for (const block of day.blocks) {
    const def = getBlock(block.type)
    if (!def?.responseSchema) continue
    // area_picker records which door she opened, which is not a confession.
    if (block.type === 'area_picker') continue
    check(
      `Day ${i + 1}: ${block.type} encrypts what she writes`,
      def.isSensitive === true,
    )
  }
}

console.log('\ncallbacks point at something real')

/*
 * Every name a screen QUOTES must be saved by an earlier screen on the SAME
 * day. A name that is never saved does not error - the quote is just missing,
 * and Day 7 stops showing her the decision she is deciding.
 */
const READS = [
  'showsEarlier',
  'echoesFrom',
  'readsArea',
  'decisionFrom',
  'meWouldFrom',
  'meWhyFrom',
  'herWouldFrom',
  'herWhyFrom',
  'whyFrom',
  'choiceFrom',
]
let danglers = 0
for (const [i, day] of days.entries()) {
  const saved = new Set<string>()
  for (const block of day.blocks) {
    const c = cfg(block)
    for (const key of READS) {
      const name = c[key]
      if (typeof name === 'string' && name && !saved.has(name)) {
        danglers++
        console.error(
          `       Day ${i + 1} ${block.type}.${key} = "${name}" is never saved earlier that day`,
        )
      }
    }
    const readsFrom = c.readsFrom as Record<string, string> | undefined
    if (readsFrom) {
      for (const [area, name] of Object.entries(readsFrom)) {
        if (!saved.has(name)) {
          danglers++
          console.error(
            `       Day ${i + 1} ${block.type}.readsFrom.${area} = "${name}" is never saved earlier that day`,
          )
        }
      }
    }
    if (typeof c.saveAs === 'string' && c.saveAs) saved.add(c.saveAs)
  }
}
check('no callback points at a name nothing saves', danglers === 0)

console.log('\nthe method, in the order it has to happen')

const d7 = typesOn(7)
check(
  'Day 7 asks ME before HER',
  days[6]!.blocks.findIndex(
    (b) => (cfg(b) as { saveAs?: string }).saveAs === 'me_would',
  ) <
    days[6]!.blocks.findIndex(
      (b) => (cfg(b) as { saveAs?: string }).saveAs === 'her_would',
    ),
)
check(
  'the comparison comes before the choice',
  d7.indexOf('me_vs_her_compare') < d7.indexOf('choice_capture'),
)
check('Day 7 ends in the card, not in a reflection', d7.includes('me_vs_her_card'))
check(
  'the decision stays visible while she answers as ME and as HER',
  days[6]!.blocks.filter(
    (b) => (cfg(b) as { showsEarlier?: string }).showsEarlier === 'decision',
  ).length >= 2,
)
check(
  'HER never gets to answer without saying why',
  days[6]!.blocks.some(
    (b) =>
      (cfg(b) as { saveAs?: string }).saveAs === 'her_why' &&
      b.isRequired === true,
  ),
)

const choice = days[6]!.blocks.find((b) => b.type === 'choice_capture')!
check(
  'choosing ME is offered a real path, not a rebuke',
  typeof (cfg(choice) as { meResponse?: string }).meResponse === 'string' &&
    (cfg(choice) as { meResponse: string }).meResponse.includes("That's okay"),
)
check(
  'ME and HER are labelled as equals',
  !JSON.stringify(cfg(choice)).toLowerCase().includes('recommend'),
)

console.log('\nDay 2 carries its safety rails')

const d2 = days[1]!.blocks.filter((b) => b.type === 'reflection_prompt')
check('Day 2 asks only its two questions', d2.length === 2, String(d2.length))
check(
  'both can be stopped without losing her writing',
  d2.every((b) => (cfg(b) as { allowStopForToday?: boolean }).allowStopForToday === true),
)

console.log('\nDay 5 collects all four areas')

const d5 = days[4]!.blocks
  .filter((b) => b.type === 'reflection_prompt')
  .map((b) => (cfg(b) as { saveAs?: string }).saveAs)
check(
  'Day 5 asks HERSELF, RELATIONSHIPS, MONEY and SUCCESS',
  JSON.stringify(d5) ===
    JSON.stringify([
      'desire_herself',
      'desire_relationships',
      'desire_money',
      'desire_success',
    ]),
  d5.join(', '),
)
check(
  'and reads all four back as THIS IS HER',
  Object.keys(
    (cfg(days[4]!.blocks.find((b) => b.type === 'her_reveal')!) as {
      readsFrom: Record<string, string>
    }).readsFrom,
  ).length === 4,
)

console.log(
  `\nME VS. HER: ${passed} passed, ${failed} failed`,
)
process.exit(failed === 0 ? 0 : 1)
