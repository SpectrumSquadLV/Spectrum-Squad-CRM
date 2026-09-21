/**
 * Seeds ME VS HER.
 *
 * The STRUCTURE is authoritative; the WORDS are not. Every prompt is marked
 * [NEEDS QUIANA'S INPUT]. The real curriculum is the product,
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


type BlockSeed = { type: string; config: Record<string, unknown>; isRequired?: boolean }
type DaySeed = { title: string; subtitle: string; minutes: number; blocks: BlockSeed[] }

const PROMPT = "[NEEDS QUIANA'S INPUT]"

/**
 * THE SEVEN DAYS.
 *
 * Six days of work and one day of rest, exactly as the methodology sets out.
 * There is no Day 8, and Day 7 is deliberately not another work day: no new
 * belief to dig for, no trigger work, and no mirror gaze.
 *
 * The STRUCTURE here is authoritative — the day titles, what happens on each
 * one, and which blocks appear in which order. The WORDS are not: every prompt
 * is marked [NEEDS QUIANA'S INPUT] and is edited in the admin, without a
 * developer and without a deploy.
 *
 * The mirror runs Days 1 to 6 with a different intention each day, tied to
 * that day's work. On Day 7 it is replaced by the spoken declaration, because
 * she has stopped looking for something and started speaking as HER.
 */
const days: DaySeed[] = [
  // ------------------------------------------------------------------ Day 1
  {
    title: 'MEET ME',
    subtitle: 'Awareness. Observation. Beginning to recognise her.',
    minutes: 20,
    blocks: [
      {
        type: 'rich_text',
        config: {
          heading: 'Day 1 — MEET ME',
          body: `${PROMPT}\n\nToday is not about changing anything. It is about noticing who shows up when something threatens you — and beginning to recognise that she has been doing a job.`,
        },
      },
      {
        type: 'mirror_gaze',
        config: {
          intention: `${PROMPT} Today, just look. You are not fixing anything.`,
          seconds: 60,
          askAfter: true,
          afterPrompt: 'What did you notice?',
        },
      },
      {
        type: 'me_portrait',
        isRequired: true,
        config: {
          prompt: `${PROMPT} Who is ME?`,
          helper: `${PROMPT} Name her, name what sets her off, and tick what she does.`,
        },
      },
      {
        type: 'milestone',
        config: {
          title: 'You met her.',
          body: 'That is the whole of Day 1. Come back tomorrow.',
        },
      },
    ],
  },

  // ------------------------------------------------------------------ Day 2
  {
    title: 'MEET YOUR PROTECTOR',
    subtitle: 'How ME has been protecting your sense of being good enough.',
    minutes: 25,
    blocks: [
      {
        type: 'rich_text',
        config: {
          heading: 'Day 2 — MEET YOUR PROTECTOR',
          body: `${PROMPT}\n\nME is not the enemy. Her whole job has been to make you feel good enough, and she has been doing it since before you could have stopped her.`,
        },
      },
      {
        type: 'mirror_gaze',
        config: {
          intention: `${PROMPT} Today, look at the one who has been protecting you.`,
          seconds: 60,
          askAfter: true,
        },
      },
      {
        type: 'callback',
        config: {
          facet: 'me_response',
          heading: 'Yesterday you said she does this',
          emptyText: '',
        },
      },
      {
        type: 'protector_profile',
        isRequired: true,
        config: {
          prompt: `${PROMPT} What has she been protecting?`,
          helper: `${PROMPT}`,
        },
      },
    ],
  },

  // ------------------------------------------------------------------ Day 3
  {
    title: 'FOLLOW THE EMOTION',
    subtitle: 'The trigger, followed backward to what you learned about yourself.',
    minutes: 30,
    blocks: [
      {
        type: 'rich_text',
        config: {
          heading: 'Day 3 — FOLLOW THE EMOTION',
          body: `${PROMPT}\n\nThe feeling is the trail. Today you follow it back: what happened, what you felt, what you did, what you were protecting, when you felt it before — and what you decided about yourself.`,
        },
      },
      {
        type: 'mirror_gaze',
        config: {
          intention: `${PROMPT} Today, look at her while you feel it.`,
          seconds: 60,
          askAfter: true,
        },
      },
      {
        type: 'callback',
        config: { facet: 'trigger', heading: 'What sets you off, in your words' },
      },
      {
        type: 'emotion_trail',
        isRequired: true,
        config: { prompt: `${PROMPT} Follow it back.`, helper: `${PROMPT}` },
      },
    ],
  },

  // ------------------------------------------------------------------ Day 4
  {
    title: 'REVIEW THE BELIEF',
    subtitle: 'Where it came from, what holds it up, and whether you are keeping it.',
    minutes: 30,
    blocks: [
      {
        type: 'rich_text',
        config: {
          heading: 'Day 4 — REVIEW THE BELIEF',
          body: `${PROMPT}\n\nYesterday you found what you learned about yourself. Today it goes on trial.`,
        },
      },
      {
        type: 'mirror_gaze',
        config: {
          intention: `${PROMPT} Today, look at her and ask whether it is true.`,
          seconds: 60,
          askAfter: true,
        },
      },
      {
        type: 'belief_review',
        isRequired: true,
        config: { prompt: `${PROMPT} The belief.`, helper: `${PROMPT}` },
      },
    ],
  },

  // ------------------------------------------------------------------ Day 5
  {
    title: 'THE PROBLEM IS YOU',
    subtitle: 'And that is the best news in the whole week.',
    minutes: 30,
    blocks: [
      {
        type: 'rich_text',
        config: {
          heading: 'Day 5 — THE PROBLEM IS YOU',
          body: `${PROMPT}\n\nRead the framing on the next screen before anything else. This day is good news, and it is easy to hear as the opposite.`,
        },
      },
      {
        type: 'mirror_gaze',
        config: {
          intention: `${PROMPT} Today, look at the woman who can change this.`,
          seconds: 60,
          askAfter: true,
        },
      },
      {
        type: 'manifestation_loop',
        isRequired: true,
        config: { prompt: `${PROMPT} The loop.`, helper: `${PROMPT}` },
      },
      {
        // The day ends in celebration on purpose: recognising that she
        // participates in the pattern is the same thing as recognising she
        // has power over it.
        type: 'celebration',
        config: {
          heading: `${PROMPT} If you are part of the pattern, you are part of the solution.`,
          body: `${PROMPT}`,
          footnote: `${PROMPT}`,
        },
      },
    ],
  },

  // ------------------------------------------------------------------ Day 6
  {
    title: 'ME VS HER',
    subtitle: 'The signature exercise. One real choice, made differently.',
    minutes: 30,
    blocks: [
      {
        type: 'rich_text',
        config: {
          heading: 'Day 6 — ME VS HER',
          body: `${PROMPT}\n\nTwo columns. What ME does, and what HER would do instead. Then you go and do one of them for real.`,
        },
      },
      {
        type: 'mirror_gaze',
        config: {
          intention: `${PROMPT} Today, look at HER.`,
          seconds: 60,
          askAfter: true,
        },
      },
      {
        type: 'dual_column_exercise',
        isRequired: true,
        config: {
          prompt: `${PROMPT} ME does this. HER does that.`,
          helper: `${PROMPT}`,
          triggerLabel: 'What sets this off?',
          currentLabel: 'ME responds by…',
          herLabel: 'HER responds by…',
        },
      },
      {
        type: 'her_choice_capture',
        isRequired: true,
        config: {
          prompt: `${PROMPT} Go and do it. Then tell me what happened.`,
          helper: `${PROMPT} This is your first I CHOSE HER.`,
        },
      },
    ],
  },

  // ------------------------------------------------------------------ Day 7
  {
    title: 'REST — LET HER LEAD',
    subtitle: 'No new work. Rest, integration, declaration, and closeout.',
    minutes: 25,
    blocks: [
      {
        type: 'rich_text',
        config: {
          heading: 'Day 7 — LET HER LEAD',
          body: `${PROMPT}\n\nNothing to dig for today. Nothing to work out. Today you read your own week back, say it out loud, and let her put the job down.`,
        },
      },
      // NO mirror_gaze on Day 7. She is not looking to discover something any
      // more — that is what the declaration below replaces.
      {
        type: 'evidence_review',
        config: {
          heading: `${PROMPT} Look what you did.`,
          body: `${PROMPT}`,
        },
      },
      {
        type: 'mirror_declaration',
        isRequired: true,
        config: {
          prompt: `${PROMPT} Say it as HER.`,
          helper: `${PROMPT} These came from your own six days. Change them until they sound like you.`,
          fallbacks: [
            `${PROMPT} I already am good enough.`,
            `${PROMPT} I do not have to earn it.`,
          ],
          beginLabel: 'Take it to the mirror',
        },
      },
      {
        type: 'me_retirement',
        isRequired: true,
        config: {
          prompt: `${PROMPT} Let her go.`,
          helper: `${PROMPT}`,
        },
      },
      {
        type: 'her_code_builder',
        config: {
          prompt: `${PROMPT} Your HER Code.`,
          helper: `${PROMPT}`,
        },
      },
      {
        type: 'milestone',
        config: {
          title: 'HER leads now.',
          body: `${PROMPT}`,
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
    { name: 'Academy enrolled', slug: 'enrolled', position: 5, isDefault: false },
  ]
  for (const stage of stages) {
    await db.insert(crmStages).values(stage).onConflictDoNothing({
      target: crmStages.slug,
    })
  }

  const slug = 'me-vs-her'

  const [program] = await db
    .insert(programs)
    .values({
      slug,
      title: 'ME VS HER',
      subtitle: 'Meet her. Choose her. Learn the way back.',
      description: PROMPT,
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
