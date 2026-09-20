/**
 * Seeds "Which version of you is running the show?".
 *
 * Unlike the assessment, this copy is REAL — a quiz cannot be tested on a
 * human being with `[PLACEHOLDER]` in it. It is still a first draft: it should
 * be read aloud by the woman whose brand this is and changed until it sounds
 * like her. The words live in two files and nowhere else:
 *
 *   - the questions: src/features/quiz/questions.ts
 *   - the four results: src/features/quiz/archetypes.ts
 *
 * Idempotent: re-running publishes a new version and leaves old attempts
 * pointing at the version they were taken against.
 *
 * Run: DATABASE_URL=... npm run seed:quiz
 */
import { desc, eq } from 'drizzle-orm'
import { db } from '../src/db/client'
import {
  assessmentQuestions,
  assessmentVersions,
  assessments,
} from '../src/db/schema/assessments'
import { quizQuestions } from '../src/features/quiz/questions'

async function main() {
  const slug = 'which-version'

  const [assessment] = await db
    .insert(assessments)
    .values({
      slug,
      title: 'Which version of you is running the show?',
      description:
        'Four versions of you — fight, flight, freeze and sulk — and the one that takes the wheel under pressure.',
      kind: 'archetype',
      isPublic: 1,
    })
    .onConflictDoUpdate({
      target: assessments.slug,
      set: { kind: 'archetype', updatedAt: new Date() },
    })
    .returning()

  if (!assessment) throw new Error('could not upsert the quiz')

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
  for (const q of quizQuestions) {
    position++
    await db.insert(assessmentQuestions).values({
      versionId: version.id,
      position,
      type: 'multiple_choice',
      prompt: q.prompt,
      // No area: an archetype quiz measures which version of her is driving,
      // not which of the four rooms it is loudest in. That mapping lives on
      // the archetype itself.
      area: null,
      config: { options: q.options },
    })
  }

  console.log(
    `seeded "${assessment.title}" v${nextVersion}: ${position} questions, 4 options each`,
  )
  console.log('the result copy lives in src/features/quiz/archetypes.ts')
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
