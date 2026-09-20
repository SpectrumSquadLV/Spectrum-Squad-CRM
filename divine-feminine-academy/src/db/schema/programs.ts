import { relations } from 'drizzle-orm'
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
import { primaryId, timestamps } from './_shared'
import { contacts } from './identity'

export const programKindEnum = pgEnum('program_kind', [
  'challenge',
  'course',
  'program',
  'membership',
])

export const programStatusEnum = pgEnum('program_status', [
  'draft',
  'published',
  'archived',
])

/** immediate = binge. drip = one unit per day. cohort/date_based = fixed start. */
export const pacingEnum = pgEnum('pacing', [
  'immediate',
  'drip',
  'cohort',
  'date_based',
])

export const programs = pgTable(
  'programs',
  {
    id: primaryId(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    description: text('description'),
    kind: programKindEnum('kind').notNull().default('challenge'),
    status: programStatusEnum('status').notNull().default('draft'),
    pacing: pacingEnum('pacing').notNull().default('drip'),
    /** Whether a woman may unlock the next day early under drip pacing. */
    allowEarlyUnlock: boolean('allow_early_unlock').notNull().default(false),
    durationDays: integer('duration_days'),
    coverMediaUrl: text('cover_media_url'),
    accessDays: integer('access_days'),
    ...timestamps,
  },
  (t) => [uniqueIndex('programs_slug_key').on(t.slug)],
)

/**
 * Content is versioned so that editing Day 3 does not change it underneath a
 * woman who is on Day 2. Enrollments pin a version.
 */
export const programVersions = pgTable(
  'program_versions',
  {
    id: primaryId(),
    programId: uuid('program_id')
      .notNull()
      .references(() => programs.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    notes: text('notes'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('program_versions_key').on(t.programId, t.version)],
)

/** For a challenge, a module is a Day. */
export const modules = pgTable(
  'modules',
  {
    id: primaryId(),
    versionId: uuid('version_id')
      .notNull()
      .references(() => programVersions.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    ...timestamps,
  },
  (t) => [uniqueIndex('modules_position_key').on(t.versionId, t.position)],
)

export const lessons = pgTable(
  'lessons',
  {
    id: primaryId(),
    moduleId: uuid('module_id')
      .notNull()
      .references(() => modules.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    title: text('title').notNull(),
    estimatedMinutes: integer('estimated_minutes'),
    ...timestamps,
  },
  (t) => [uniqueIndex('lessons_position_key').on(t.moduleId, t.position)],
)

/**
 * THE HEART OF THE SYSTEM.
 *
 * `type` names a React component in the block registry. `config` holds that
 * block's content, validated by the registry's Zod schema for that type.
 *
 * A new PROGRAM needs no code. A new BLOCK TYPE needs one component plus one
 * registry entry, and nothing else changes.
 */
export const lessonBlocks = pgTable(
  'lesson_blocks',
  {
    id: primaryId(),
    lessonId: uuid('lesson_id')
      .notNull()
      .references(() => lessons.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    type: text('type').notNull(),
    config: jsonb('config').notNull().default({}),
    isRequired: boolean('is_required').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('lesson_blocks_position_key').on(t.lessonId, t.position),
    index('lesson_blocks_type_idx').on(t.type),
  ],
)

export const cohortStatusEnum = pgEnum('cohort_status', [
  'draft',
  'scheduled',
  'cancelled',
])

/**
 * A LIVE RUN of a programme.
 *
 * Everything else here is evergreen, which means nothing on the site has ever
 * had a reason to be bought today. A cohort is the opposite: it starts on a
 * date, doors open and shut, and everybody moves through it together.
 *
 * Two things are load-bearing.
 *
 * `timezone` is the COHORT's clock, not hers. Under cohort pacing the day
 * everybody is on has to be the same day, or a woman in Auckland is on Day 3
 * while the live session is running Day 2.
 *
 * The three `announced*` columns are how an announcement happens once. Editing
 * a cohort, moving its dates, or re-running the hourly job cannot re-send.
 */
export const cohorts = pgTable(
  'cohorts',
  {
    id: primaryId(),
    programId: uuid('program_id')
      .notNull()
      .references(() => programs.id, { onDelete: 'cascade' }),
    versionId: uuid('version_id').references(() => programVersions.id),

    /**
     * The public URL. Nullable so a half-made cohort can exist without one —
     * a cohort with no slug simply has no public page yet.
     */
    slug: text('slug'),
    name: text('name').notNull(),
    /** The one-line promise on the public page. */
    promise: text('promise'),
    description: text('description'),

    status: cohortStatusEnum('status').notNull().default('draft'),

    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    /** The cohort's own clock. Decides which day everybody is on. */
    timezone: text('timezone').notNull().default('America/Los_Angeles'),

    /** The enrolment window. Null means open until it starts. */
    enrollmentOpensAt: timestamp('enrollment_opens_at', { withTimezone: true }),
    enrollmentClosesAt: timestamp('enrollment_closes_at', { withTimezone: true }),

    /** What it costs. Null means it is free to join. */
    offerId: uuid('offer_id'),

    capacity: integer('capacity'),

    announcedOpenAt: timestamp('announced_open_at', { withTimezone: true }),
    announcedClosingAt: timestamp('announced_closing_at', { withTimezone: true }),
    announcedStartAt: timestamp('announced_start_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('cohorts_program_idx').on(t.programId, t.startsAt),
    uniqueIndex('cohorts_slug_key').on(t.slug),
    index('cohorts_status_idx').on(t.status, t.startsAt),
  ],
)

/** One live call. */
export const cohortSessions = pgTable(
  'cohort_sessions',
  {
    id: primaryId(),
    cohortId: uuid('cohort_id')
      .notNull()
      .references(() => cohorts.id, { onDelete: 'cascade' }),
    dayNumber: integer('day_number'),
    title: text('title').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    durationMinutes: integer('duration_minutes').notNull().default(60),
    /**
     * Where to join, and where the recording lives afterwards.
     *
     * Deliberately plain text rather than anything clever: this is a Zoom link
     * somebody pastes in, and it changes.
     */
    joinUrl: text('join_url'),
    replayUrl: text('replay_url'),
    ...timestamps,
  },
  (t) => [index('cohort_sessions_idx').on(t.cohortId, t.startsAt)],
)

/**
 * Women waiting for the doors to open.
 *
 * `notifiedAt` is per-woman rather than per-cohort so somebody who joins the
 * waitlist AFTER the doors opened still gets told, instead of being silently
 * skipped because the cohort was already marked announced.
 */
export const cohortWaitlist = pgTable(
  'cohort_waitlist',
  {
    id: primaryId(),
    cohortId: uuid('cohort_id')
      .notNull()
      .references(() => cohorts.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    joinedAt: timestamp('joined_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('cohort_waitlist_key').on(t.cohortId, t.contactId),
    index('cohort_waitlist_pending_idx').on(t.cohortId, t.notifiedAt),
  ],
)

export const programsRelations = relations(programs, ({ many }) => ({
  versions: many(programVersions),
  cohorts: many(cohorts),
}))

export const programVersionsRelations = relations(
  programVersions,
  ({ one, many }) => ({
    program: one(programs, {
      fields: [programVersions.programId],
      references: [programs.id],
    }),
    modules: many(modules),
  }),
)

export const modulesRelations = relations(modules, ({ one, many }) => ({
  version: one(programVersions, {
    fields: [modules.versionId],
    references: [programVersions.id],
  }),
  lessons: many(lessons),
}))

export const lessonsRelations = relations(lessons, ({ one, many }) => ({
  module: one(modules, { fields: [lessons.moduleId], references: [modules.id] }),
  blocks: many(lessonBlocks),
}))

export const lessonBlocksRelations = relations(lessonBlocks, ({ one }) => ({
  lesson: one(lessons, {
    fields: [lessonBlocks.lessonId],
    references: [lessons.id],
  }),
}))
