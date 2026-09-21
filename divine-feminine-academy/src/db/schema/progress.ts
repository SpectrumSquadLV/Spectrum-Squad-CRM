import {
  boolean,
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
import { cohorts, lessonBlocks, lessons, programVersions, programs } from './programs'

export const enrollmentStatusEnum = pgEnum('enrollment_status', [
  'active',
  'completed',
  'paused',
  'expired',
  'refunded',
])

export const enrollments = pgTable(
  'enrollments',
  {
    id: primaryId(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    programId: uuid('program_id')
      .notNull()
      .references(() => programs.id),
    /** Pinned at enrollment so content edits never shift under her. */
    versionId: uuid('version_id')
      .notNull()
      .references(() => programVersions.id),
    cohortId: uuid('cohort_id').references(() => cohorts.id),
    status: enrollmentStatusEnum('status').notNull().default('active'),
    currentDay: integer('current_day').notNull().default(1),
    /** Drip unlocks are computed in the timezone she started in. */
    timezoneAtStart: text('timezone_at_start').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    accessExpiresAt: timestamp('access_expires_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('enrollments_contact_idx').on(t.contactId),
    index('enrollments_program_status_idx').on(t.programId, t.status),
  ],
)

export const lessonProgressStatusEnum = pgEnum('lesson_progress_status', [
  'not_started',
  'in_progress',
  'completed',
])

export const lessonProgress = pgTable(
  'lesson_progress',
  {
    id: primaryId(),
    enrollmentId: uuid('enrollment_id')
      .notNull()
      .references(() => enrollments.id, { onDelete: 'cascade' }),
    lessonId: uuid('lesson_id')
      .notNull()
      .references(() => lessons.id, { onDelete: 'cascade' }),
    status: lessonProgressStatusEnum('status').notNull().default('not_started'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('lesson_progress_key').on(t.enrollmentId, t.lessonId)],
)

/**
 * Everything she types inside a lesson.
 *
 * `isSensitive` mirrors the block registry: when the registry marks a block
 * type sensitive, `response` is stored as ciphertext exactly like a journal
 * body, and admin surfaces only ever see that the block was answered.
 */
export const blockResponses = pgTable(
  'block_responses',
  {
    id: primaryId(),
    enrollmentId: uuid('enrollment_id')
      .notNull()
      .references(() => enrollments.id, { onDelete: 'cascade' }),
    blockId: uuid('block_id')
      .notNull()
      .references(() => lessonBlocks.id, { onDelete: 'cascade' }),
    response: jsonb('response'),
    responseEncrypted: text('response_encrypted'),
    isSensitive: boolean('is_sensitive').notNull().default(false),
    answeredAt: timestamp('answered_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    ...timestamps,
  },
  (t) => [uniqueIndex('block_responses_key').on(t.enrollmentId, t.blockId)],
)

/**
 * Day 1's output, kept permanently.
 *
 * This is the platform's memory of who she is becoming, and the reason a
 * course player cannot compete with it. Every later program reads from here.
 */
export const herPatterns = pgTable(
  'her_patterns',
  {
    id: primaryId(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    area: areaEnum('area'),
    triggerText: text('trigger_text').notNull(),
    currentResponse: text('current_response'),
    currentTags: text('current_tags').array(),
    herResponse: text('her_response'),
    herTags: text('her_tags').array(),
    /**
     * Day 2, where ME learned it. Ciphertext, journal-grade.
     *
     * The columns above are plaintext because they are behaviours - "I go
     * quiet", "when nobody notices" - and she sees them on her own HER page.
     * These two are not behaviours. They are the earliest time she remembers
     * feeling this way and what she needed and did not receive, which is the
     * heaviest thing the challenge asks for, so they are encrypted with her
     * own key like a journal body and no staff surface can read them.
     */
    originMemoryEncrypted: text('origin_memory_encrypted'),
    unmetNeedEncrypted: text('unmet_need_encrypted'),
    sourceEnrollmentId: uuid('source_enrollment_id').references(
      () => enrollments.id,
    ),
    /**
     * The lesson block that produced this, when one did. Re-saving that block
     * updates its pattern instead of adding a second one. Null for patterns
     * she adds herself outside a lesson.
     */
    sourceBlockId: uuid('source_block_id').references(() => lessonBlocks.id, {
      onDelete: 'set null',
    }),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('her_patterns_contact_idx').on(t.contactId),
    uniqueIndex('her_patterns_source_block_key').on(
      t.sourceEnrollmentId,
      t.sourceBlockId,
    ),
  ],
)

/** The core metric of the whole platform. */
export const herChoices = pgTable(
  'her_choices',
  {
    id: primaryId(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    programId: uuid('program_id').references(() => programs.id),
    patternId: uuid('pattern_id').references(() => herPatterns.id),
    /** The lesson block that logged this, when one did. Keeps re-saves idempotent. */
    sourceBlockId: uuid('source_block_id').references(() => lessonBlocks.id, {
      onDelete: 'set null',
    }),
    area: areaEnum('area'),
    situation: text('situation'),
    oldResponse: text('old_response'),
    herResponse: text('her_response'),
    reflection: text('reflection'),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    ...timestamps,
  },
  (t) => [
    index('her_choices_contact_idx').on(t.contactId, t.occurredAt),
    uniqueIndex('her_choices_source_block_key').on(t.contactId, t.sourceBlockId),
  ],
)

export const returnActionEnum = pgEnum('return_action', [
  'dance',
  'create',
  'move',
  'music',
  'nature',
  'play',
  'rest',
  'connect',
  'journal',
  'custom',
])

/**
 * Day 5's practice, available forever from one tap anywhere.
 *
 * She reaches this on a bad day, at low capacity. Whatever is built on top of
 * it stays large, calm and short.
 */
export const returnSessions = pgTable(
  'return_sessions',
  {
    id: primaryId(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    whatHappened: text('what_happened'),
    feeling: text('feeling'),
    meaningMade: text('meaning_made'),
    isItTrue: text('is_it_true'),
    whatINeed: text('what_i_need'),
    actionChosen: returnActionEnum('action_chosen'),
    customAction: text('custom_action'),
    actionCompletedAt: timestamp('action_completed_at', { withTimezone: true }),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    ...timestamps,
  },
  (t) => [index('return_sessions_contact_idx').on(t.contactId, t.occurredAt)],
)

/**
 * What she allows herself to want, one row per area.
 *
 * Day 5 is the first day HER appears, and these four answers ARE her: not a
 * plan, not a goal, and explicitly not filtered through what is realistic.
 * They are read back to her on the same day as THIS IS HER, offered again on
 * Day 6 while she chooses one small thing, and available on Day 7 while she
 * looks at a real decision through HER.
 *
 * Kept in their own table rather than left in block_responses because they
 * outlive the challenge. Every later program, and the Academy, reads from
 * here; a woman should never be asked what she wants twice.
 *
 * Encrypted, like the journal. These are the most tender sentences in the
 * product - a woman writing down what she actually wants, having spent four
 * days learning why she stopped. Nobody but her reads them.
 */
export const herDesires = pgTable(
  'her_desires',
  {
    id: primaryId(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    area: areaEnum('area').notNull(),
    /** Ciphertext. Her key, wrapped by the master key. Never plaintext. */
    textEncrypted: text('text_encrypted').notNull(),
    sourceEnrollmentId: uuid('source_enrollment_id').references(
      () => enrollments.id,
    ),
    /** Re-saving Day 5 updates her answer rather than adding a second one. */
    sourceBlockId: uuid('source_block_id').references(() => lessonBlocks.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (t) => [
    index('her_desires_contact_idx').on(t.contactId),
    // One desire per area per enrollment: Day 5 asks each question once.
    uniqueIndex('her_desires_area_key').on(
      t.contactId,
      t.sourceEnrollmentId,
      t.area,
    ),
  ],
)

/** The growth loop. Built on Day 7, designed to be screenshot and shared. */
export const herCodes = pgTable(
  'her_codes',
  {
    id: primaryId(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    programId: uuid('program_id').references(() => programs.id),
    sections: jsonb('sections').notNull().default([]),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    shareToken: text('share_token'),
    pdfUrl: text('pdf_url'),
    ...timestamps,
  },
  (t) => [
    index('her_codes_contact_idx').on(t.contactId),
    uniqueIndex('her_codes_share_token_key').on(t.shareToken),
  ],
)

/**
 * The mirror.
 *
 * A daily practice across all seven days, each with an intention tied to that
 * day's work. This table is METADATA ONLY — how long she was asked for, how
 * long she actually stayed, and whether she finished. Anything she wrote
 * afterwards is a journal entry and is encrypted like every other one.
 *
 * `secondsAsked` and `secondsCompleted` are kept apart on purpose. "She
 * started it and stopped at forty seconds" is the single most useful number
 * in the whole challenge: it is the moment a woman meets her own face and
 * looks away, and it is almost certainly where people quit.
 */
export const mirrorSessions = pgTable(
  'mirror_sessions',
  {
    id: primaryId(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    enrollmentId: uuid('enrollment_id').references(() => enrollments.id, {
      onDelete: 'cascade',
    }),
    /** The block that produced it. Re-doing the practice updates the row. */
    sourceBlockId: uuid('source_block_id').references(() => lessonBlocks.id, {
      onDelete: 'set null',
    }),
    dayNumber: integer('day_number'),
    /** The line held on screen while she looks. Stored so it can change. */
    intention: text('intention'),
    secondsAsked: integer('seconds_asked').notNull().default(60),
    secondsCompleted: integer('seconds_completed').notNull().default(0),
    /**
     * How many times she chose ONE MORE MINUTE.
     *
     * The most quietly encouraging number in the product. A woman who could
     * not hold thirty seconds on Day 1 and extends twice on Day 5 has a
     * measurable week, and it is measured in something other than compliance.
     */
    extensions: integer('extensions').notNull().default(0),
    /** True when she used "I need to stop". Never treated as a failure. */
    stoppedEarly: boolean('stopped_early').notNull().default(false),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('mirror_sessions_contact_idx').on(t.contactId, t.createdAt),
    uniqueIndex('mirror_sessions_source_block_key').on(
      t.enrollmentId,
      t.sourceBlockId,
    ),
  ],
)

export const journalSourceEnum = pgEnum('journal_source', [
  'free_write',
  'lesson_prompt',
  'return_practice',
  'her_choice',
])

/**
 * ENCRYPTED. `bodyEncrypted` is AES-256-GCM ciphertext produced in the
 * application before it reaches Postgres. Opening the database shows nothing
 * readable - not to a developer, not to support, not to the owner.
 *
 * `wordCount`, `category` and the timestamps are stored in the clear so admin
 * screens can show engagement without ever seeing the words.
 */
export const journalEntries = pgTable(
  'journal_entries',
  {
    id: primaryId(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    title: text('title'),
    bodyEncrypted: text('body_encrypted').notNull(),
    area: areaEnum('area'),
    source: journalSourceEnum('source').notNull().default('free_write'),
    programId: uuid('program_id').references(() => programs.id),
    lessonId: uuid('lesson_id').references(() => lessons.id),
    /** Metadata, deliberately in the clear. */
    wordCount: integer('word_count').notNull().default(0),
    ...timestamps,
  },
  (t) => [index('journal_entries_contact_idx').on(t.contactId, t.createdAt)],
)

/** The ONLY path by which a human other than her reads an entry. Revocable. */
export const journalShares = pgTable(
  'journal_shares',
  {
    id: primaryId(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'cascade' }),
    sharedWithUserId: uuid('shared_with_user_id').notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('journal_shares_key').on(t.entryId, t.sharedWithUserId)],
)

/**
 * Per-contact data encryption key, itself encrypted with the master key.
 * Deleting this row makes every entry for that woman permanently unreadable,
 * which is how account deletion is honoured.
 */
export const contactEncryptionKeys = pgTable(
  'contact_encryption_keys',
  {
    id: primaryId(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    wrappedKey: text('wrapped_key').notNull(),
    keyVersion: integer('key_version').notNull().default(1),
    ...timestamps,
  },
  (t) => [uniqueIndex('contact_encryption_keys_key').on(t.contactId)],
)

export const milestones = pgTable(
  'milestones',
  {
    id: primaryId(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    area: areaEnum('area'),
    ...timestamps,
  },
  (t) => [uniqueIndex('milestones_slug_key').on(t.slug)],
)

export const contactMilestones = pgTable(
  'contact_milestones',
  {
    id: primaryId(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    milestoneId: uuid('milestone_id')
      .notNull()
      .references(() => milestones.id, { onDelete: 'cascade' }),
    achievedAt: timestamp('achieved_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    note: text('note'),
    ...timestamps,
  },
  (t) => [uniqueIndex('contact_milestones_key').on(t.contactId, t.milestoneId)],
)
