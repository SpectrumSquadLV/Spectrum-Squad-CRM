/**
 * Seeds the free assessment.
 *
 * EVERY QUESTION HERE IS A PLACEHOLDER. A real instrument is written by
 * somebody who knows what they are measuring; these exist so the engine, the
 * scoring and the pre/post comparison can be used and tested.
 *
 * Note the reverse-scored items: an honest instrument mixes the direction of
 * its statements so agreeing with everything does not flatter the taker.
 *
 * Idempotent: re-running publishes a new version.
 *
 * Run: DATABASE_URL=... npm run seed:assessment
 */
import { desc, eq } from 'drizzle-orm'
import { db } from '../src/db/client'
import {
  assessmentQuestions,
  assessmentVersions,
  assessments,
} from '../src/db/schema/assessments'

const PLACEHOLDER = '[PLACEHOLDER]'

type Seed = {
  prompt: string
  area: 'self' | 'love' | 'life' | 'wealth'
  reverseScored?: boolean
}

const likerts: Seed[] = [
  { prompt: `${PLACEHOLDER} I speak to myself the way I would speak to a friend.`, area: 'self' },
  { prompt: `${PLACEHOLDER} I apologise for things that are not my fault.`, area: 'self', reverseScored: true },
  { prompt: `${PLACEHOLDER} I ask for what I want directly.`, area: 'love' },
  { prompt: `${PLACEHOLDER} I accept less than I want to keep the peace.`, area: 'love', reverseScored: true },
  { prompt: `${PLACEHOLDER} My days look like the life I actually chose.`, area: 'life' },
  { prompt: `${PLACEHOLDER} I say yes when I mean no.`, area: 'life', reverseScored: true },
  { prompt: `${PLACEHOLDER} I believe I am allowed to want more money.`, area: 'wealth' },
  { prompt: `${PLACEHOLDER} I undercharge, or avoid naming a price.`, area: 'wealth', reverseScored: true },
]

async function main() {
  const slug = 'where-are-you'

  const [assessment] = await db
    .insert(assessments)
    .values({
      slug,
      title: 'Where are you, honestly?',
      description: PLACEHOLDER,
      isPublic: 1,
    })
    .onConflictDoUpdate({
      target: assessments.slug,
      set: { updatedAt: new Date() },
    })
    .returning()

  if (!assessment) throw new Error('could not upsert the assessment')

  const [latest] = await db
    .select({ version: assessmentVersions.version })
    .from(assessmentVersions)
    .where(eq(assessmentVersions.assessmentId, assessment.id))
    .orderBy(desc(assessmentVersions.version))
    .limit(1)

  const nextVersion = (latest?.version ?? 0) + 1

  const [version] = await db
    .insert(assessmentVersions)
    .values({
      assessmentId: assessment.id,
      version: nextVersion,
      publishedAt: new Date(),
    })
    .returning()

  if (!version) throw new Error('could not create a version')

  let position = 0
  for (const q of likerts) {
    position++
    await db.insert(assessmentQuestions).values({
      versionId: version.id,
      position,
      type: 'likert',
      prompt: q.prompt,
      area: q.area,
      config: {
        min: 1,
        max: 5,
        reverseScored: q.reverseScored ?? false,
        minLabel: 'Never',
        maxLabel: 'Always',
      },
    })
  }

  // One open question, which must never contribute to the score.
  position++
  await db.insert(assessmentQuestions).values({
    versionId: version.id,
    position,
    type: 'open',
    prompt: `${PLACEHOLDER} What would you change first, if nothing were in the way?`,
    area: null,
    config: {},
  })

  console.log(
    `seeded "${assessment.title}" v${nextVersion}: ${position} questions (${likerts.length} scored, 1 open)`,
  )
  console.log('every question is placeholder copy, not a validated instrument')
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
