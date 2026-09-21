import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { areaEnum, primaryId, timestamps } from './_shared'
import { contacts } from './identity'
import { programs } from './programs'

/**
 * How an assessment is read.
 *
 * `scored` normalises to 0-100 per area. `archetype` sorts her into one of a
 * fixed set of named types. They are different instruments with different
 * maths, and storing which one this is stops a quiz being scored as a survey.
 */
export const assessmentKindEnum = pgEnum('assessment_kind', [
  'scored',
  'archetype',
])

export const assessments = pgTable(
  'assessments',
  {
    id: primaryId(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    kind: assessmentKindEnum('kind').notNull().default('scored'),
    isPublic: integer('is_public').notNull().default(1),
    ...timestamps,
  },
  (t) => [uniqueIndex('assessments_slug_key').on(t.slug)],
)

export const assessmentVersions = pgTable(
  'assessment_versions',
  {
    id: primaryId(),
    assessmentId: uuid('assessment_id')
      .notNull()
      .references(() => assessments.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('assessment_versions_key').on(t.assessmentId, t.version)],
)

export const questionTypeEnum = pgEnum('question_type', [
  'likert',
  'multiple_choice',
  'open',
])

export const assessmentQuestions = pgTable(
  'assessment_questions',
  {
    id: primaryId(),
    versionId: uuid('version_id')
      .notNull()
      .references(() => assessmentVersions.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    type: questionTypeEnum('type').notNull(),
    prompt: text('prompt').notNull(),
    area: areaEnum('area'),
    /** { options: [...], min, max, reverseScored } */
    config: jsonb('config').notNull().default({}),
    ...timestamps,
  },
  (t) => [uniqueIndex('assessment_questions_key').on(t.versionId, t.position)],
)

export const attemptTimingEnum = pgEnum('attempt_timing', ['pre', 'post', 'standalone'])

export const assessmentAttempts = pgTable(
  'assessment_attempts',
  {
    id: primaryId(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    versionId: uuid('version_id')
      .notNull()
      .references(() => assessmentVersions.id),
    programId: uuid('program_id').references(() => programs.id),
    timing: attemptTimingEnum('timing').notNull().default('standalone'),
    /** Emailed token so results open without a login. */
    resultToken: text('result_token'),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('assessment_attempts_contact_idx').on(t.contactId),
    uniqueIndex('assessment_attempts_token_key').on(t.resultToken),
  ],
)

export const assessmentResponses = pgTable(
  'assessment_responses',
  {
    id: primaryId(),
    attemptId: uuid('attempt_id')
      .notNull()
      .references(() => assessmentAttempts.id, { onDelete: 'cascade' }),
    questionId: uuid('question_id')
      .notNull()
      .references(() => assessmentQuestions.id, { onDelete: 'cascade' }),
    value: jsonb('value'),
    ...timestamps,
  },
  (t) => [uniqueIndex('assessment_responses_key').on(t.attemptId, t.questionId)],
)

export const assessmentResults = pgTable(
  'assessment_results',
  {
    id: primaryId(),
    attemptId: uuid('attempt_id')
      .notNull()
      .references(() => assessmentAttempts.id, { onDelete: 'cascade' }),
    overallScore: integer('overall_score'),
    /**
     * For a `scored` assessment: { herself: n, relationships: n, money: n, success: n }.
     * For an `archetype` quiz: the share each mode took, 0-100.
     */
    categoryScores: jsonb('category_scores').notNull().default({}),
    /**
     * The protective mode she came out as, on an `archetype` quiz. Text rather
     * than an enum on purpose: the four modes are a content decision that will
     * be edited by somebody who is not a developer, and a migration to rename
     * one would be absurd.
     */
    archetype: text('archetype'),
    /** The runner-up, when it was close enough to be worth naming. */
    secondaryArchetype: text('secondary_archetype'),
    narrative: text('narrative'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('assessment_results_key').on(t.attemptId),
    index('assessment_results_archetype_idx').on(t.archetype),
  ],
)
