/**
 * Seeds ME VS. HER.
 *
 * The curriculum itself lives in src/features/challenge/curriculum.ts, so it
 * can be TESTED rather than only run, and every word of it is Quiana's. This
 * script is now only the mechanics: upsert the programme, publish a new
 * version, write the modules, lessons and blocks.
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
import { days } from '../src/features/challenge/curriculum'


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
      subtitle: 'Meet her. Choose her. Let her lead.',
      description:
        'Seven days. Meet the version of you that shows up automatically, meet the woman underneath her, and learn what to do when they want different things.',
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
      notes: 'ME VS. HER, the approved curriculum.',
      publishedAt: new Date(),
    })
    .returning()

  if (!version) throw new Error('could not create a version')

  /*
   * What a woman has to do to earn the certificate. Without these rows the
   * programme awards nothing - silence does not mean yes.
   */
  /*
   * Two requirements, and the two that are NOT here matter as much.
   *
   * her_code_finalized is gone because the HER Code belonged to the old Day
   * 7, which was a retirement ceremony; the approved Day 7 is a real decision
   * instead. Requiring a code would have left every woman who finished unable
   * to earn the certificate, with nothing on screen telling her why.
   *
   * her_choices_logged is gone for a more important reason. Day 7 lets her
   * consciously choose ME, and says so without shame - and a choice counter
   * only counts HER. Requiring one would have meant the product said
   * "choosing ME is allowed" and then quietly withheld her certificate for
   * it, which is worse than never having offered the choice.
   *
   * What is left is honest: finish the days, answer the required exercises.
   * choice_capture is itself a required block, so she cannot finish Day 7
   * without making the choice - only without making a particular one.
   */
  for (const requirement of [
    { requirementType: 'lessons_completed_pct' as const, threshold: 100 },
    { requirementType: 'required_blocks_answered' as const, threshold: 0 },
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
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
