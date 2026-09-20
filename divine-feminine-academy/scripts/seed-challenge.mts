/**
 * Seeds 7 DAYS TO HER.
 *
 * EVERY PROMPT HERE IS PLACEHOLDER COPY. The real curriculum is the product,
 * and it is not written yet. This exists so the engine can be built, run and
 * tested end to end; each day's prompts are marked so nothing invented here
 * can be mistaken for the real thing.
 *
 * Idempotent: safe to run repeatedly. Re-running publishes a NEW version
 * rather than editing the current one, so nobody mid-challenge has content
 * shift underneath her.
 *
 * Run: DATABASE_URL=... npm run seed:challenge
 */
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../src/db/client'
// Imported from the concrete modules rather than the barrel: `export *`
// re-exports do not resolve to named ESM bindings under tsx's transpile-only
// loader, which the bundler hides in the app but a script hits directly.
import { certificateRequirements } from '../src/db/schema/certificates'
import { crmStages } from '../src/db/schema/identity'
import {
  lessonBlocks,
  lessons,
  modules,
  programVersions,
  programs,
} from '../src/db/schema/programs'

const PLACEHOLDER = '[PLACEHOLDER COPY — awaiting the real curriculum]'

type BlockSeed = { type: string; config: Record<string, unknown>; isRequired?: boolean }
type DaySeed = { title: string; subtitle: string; minutes: number; blocks: BlockSeed[] }

const days: DaySeed[] = [
  {
    title: 'Meet her',
    subtitle: 'Name the woman you keep catching glimpses of.',
    minutes: 20,
    blocks: [
      {
        type: 'rich_text',
        config: {
          heading: 'Day 1',
          body: `${PLACEHOLDER}\n\nToday you name her. Not an aspiration — a specific woman, with specific responses, in the situations you actually live in.\n\nStart with one thing that sets you off.`,
        },
      },
      {
        type: 'dual_column_exercise',
        isRequired: true,
        config: {
          prompt: 'What sets you off, and what she does instead',
          helper: `${PLACEHOLDER} This becomes your HER profile. Everything later reads from it.`,
          triggerLabel: 'What sets this off?',
          currentLabel: 'Current Me responds by...',
          herLabel: 'HER responds by...',
        },
      },
      {
        type: 'milestone',
        config: {
          title: 'You named her.',
          body: 'That is the whole of Day 1. Come back tomorrow.',
        },
      },
    ],
  },
  {
    title: 'Where it started',
    subtitle: 'The belief underneath the pattern.',
    minutes: 25,
    blocks: [
      {
        type: 'rich_text',
        config: {
          heading: 'Day 2',
          body: `${PLACEHOLDER}\n\nToday goes underneath yesterday. Every pattern sits on a belief, and every belief was learned somewhere.\n\nThis one asks a lot. Take it at your own pace — nobody here can read what you write.`,
        },
      },
      {
        type: 'belief_origin',
        isRequired: true,
        config: {
          prompt: 'The belief, and where you learned it',
          helper: `${PLACEHOLDER} Encrypted. Only you can read this.`,
        },
      },
    ],
  },
  {
    title: 'Whose approval',
    subtitle: 'An honest audit of who you are performing for.',
    minutes: 20,
    blocks: [
      {
        type: 'rich_text',
        config: {
          heading: 'Day 3',
          body: `${PLACEHOLDER}\n\nToday is an inventory. Whose approval are you still arranging your life around, and what does arranging it cost you?`,
        },
      },
      {
        type: 'validation_audit',
        isRequired: true,
        config: {
          prompt: 'Whose approval are you still arranging your life around?',
          helper: `${PLACEHOLDER} Three is a start. Add more if they come.`,
          minEntries: 3,
        },
      },
    ],
  },
  {
    title: 'The behaviour',
    subtitle: 'One thing you keep doing that she would not.',
    minutes: 15,
    blocks: [
      {
        type: 'rich_text',
        config: {
          heading: 'Day 4',
          body: `${PLACEHOLDER}\n\nBeliefs are interesting. Behaviour is what changes your life. Today you pick one and get specific about it.`,
        },
      },
      {
        type: 'behavior_commitment',
        isRequired: true,
        config: {
          prompt: 'One thing you keep doing that HER would not',
          helper: `${PLACEHOLDER} Specific enough that you will know whether you did it.`,
        },
      },
      {
        type: 'action_commitment',
        config: {
          prompt: 'And one thing you will do about it',
          helper: `${PLACEHOLDER}`,
          suggestions: ['Say the thing', 'Leave early', 'Ask directly', 'Say no'],
        },
      },
    ],
  },
  {
    title: 'The way back',
    subtitle: 'You will lose her. This is how you return.',
    minutes: 20,
    blocks: [
      {
        type: 'rich_text',
        config: {
          heading: 'Day 5',
          body: `${PLACEHOLDER}\n\nYou will lose her. Everyone does. The practice that matters is not staying — it is returning, and knowing exactly how.\n\nThis is the one you keep for life.`,
        },
      },
      {
        type: 'return_practice',
        isRequired: true,
        config: {
          prompt: 'The RETURN practice',
          helper: `${PLACEHOLDER} Walk it once now, on something real but small. It is here whenever you need it.`,
          teaching: true,
        },
      },
      {
        type: 'milestone',
        config: {
          title: 'This one is yours for good.',
          body: 'RETURN stays in your account, one tap from anywhere.',
        },
      },
    ],
  },
  {
    title: 'I chose HER',
    subtitle: 'Start logging it, in the moment.',
    minutes: 10,
    blocks: [
      {
        type: 'rich_text',
        config: {
          heading: 'Day 6',
          body: `${PLACEHOLDER}\n\nToday is short, because today happens all day. Every time you choose her instead, log it. From your phone, in the moment, in ten seconds.`,
        },
      },
      {
        type: 'her_choice_capture',
        isRequired: true,
        config: {
          prompt: 'One time today you chose HER',
          helper: `${PLACEHOLDER} Log as many as you like — this is the number you will look back on.`,
        },
      },
    ],
  },
  {
    title: 'Your HER Code',
    subtitle: 'Read your week back, then write what you live by.',
    minutes: 25,
    blocks: [
      {
        type: 'rich_text',
        config: {
          heading: 'Day 7',
          body: `${PLACEHOLDER}\n\nBefore you write anything, read what you already did.`,
        },
      },
      { type: 'evidence_review', config: { prompt: 'Look at what you did.' } },
      {
        type: 'her_code_builder',
        isRequired: true,
        config: {
          prompt: 'Your HER Code',
          helper: `${PLACEHOLDER} In your words. This is yours to keep and yours to share.`,
          lineCount: 5,
          linePlaceholder: 'I am the woman who…',
        },
      },
      {
        type: 'milestone',
        config: {
          title: 'Seven days.',
          body: 'Your HER Code is in your account. So is everything else you wrote.',
        },
      },
    ],
  },
]

async function main() {
  // CRM stages, so a new contact has somewhere to land.
  const stages = [
    { name: 'Lead', slug: 'lead', position: 1, isDefault: true },
    { name: 'Challenge started', slug: 'challenge-started', position: 2, isDefault: false },
    { name: 'Challenge complete', slug: 'challenge-complete', position: 3, isDefault: false },
    { name: 'Academy prospect', slug: 'academy-prospect', position: 4, isDefault: false },
    { name: 'Academy enrolled', slug: 'academy-enrolled', position: 5, isDefault: false },
  ]
  for (const stage of stages) {
    await db.insert(crmStages).values(stage).onConflictDoNothing({
      target: crmStages.slug,
    })
  }

  const slug = '7-days-to-her'

  const [program] = await db
    .insert(programs)
    .values({
      slug,
      title: '7 DAYS TO HER',
      subtitle: 'Meet her. Choose her. Learn the way back.',
      description: PLACEHOLDER,
      kind: 'challenge',
      status: 'published',
      pacing: 'drip',
      allowEarlyUnlock: false,
      durationDays: days.length,
    })
    .onConflictDoUpdate({
      target: programs.slug,
      set: { durationDays: days.length, updatedAt: new Date() },
    })
    .returning()

  if (!program) throw new Error('could not upsert the programme')

  // A new version every run: content edits must never shift under a woman who
  // is already mid-challenge.
  const [latest] = await db
    .select({ version: programVersions.version })
    .from(programVersions)
    .where(eq(programVersions.programId, program.id))
    .orderBy(desc(programVersions.version))
    .limit(1)

  const nextVersion = (latest?.version ?? 0) + 1

  const [version] = await db
    .insert(programVersions)
    .values({
      programId: program.id,
      version: nextVersion,
      notes: 'Seeded with placeholder curriculum.',
      publishedAt: new Date(),
    })
    .returning()

  if (!version) throw new Error('could not create a version')

  /*
   * What a woman has to do to earn the certificate. Without these rows the
   * programme awards nothing - silence does not mean yes.
   */
  for (const requirement of [
    { requirementType: 'lessons_completed_pct' as const, threshold: 100 },
    { requirementType: 'required_blocks_answered' as const, threshold: 0 },
    { requirementType: 'her_code_finalized' as const, threshold: 0 },
  ]) {
    await db
      .insert(certificateRequirements)
      .values({ programId: program.id, ...requirement })
      .onConflictDoNothing({
        target: [
          certificateRequirements.programId,
          certificateRequirements.requirementType,
        ],
      })
  }

  let blockCount = 0
  for (const [index, day] of days.entries()) {
    const [dayModule] = await db
      .insert(modules)
      .values({
        versionId: version.id,
        position: index + 1,
        title: day.title,
        subtitle: day.subtitle,
      })
      .returning()

    if (!dayModule) continue

    const [lesson] = await db
      .insert(lessons)
      .values({
        moduleId: dayModule.id,
        position: 1,
        title: day.title,
        estimatedMinutes: day.minutes,
      })
      .returning()

    if (!lesson) continue

    for (const [i, block] of day.blocks.entries()) {
      await db.insert(lessonBlocks).values({
        lessonId: lesson.id,
        position: i + 1,
        type: block.type,
        config: block.config,
        isRequired: block.isRequired ?? false,
      })
      blockCount++
    }
  }

  console.log(
    `seeded ${program.title} v${nextVersion}: ${days.length} days, ${blockCount} blocks, 3 certificate requirements`,
  )
  console.log('every prompt is placeholder copy awaiting the real curriculum')
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
