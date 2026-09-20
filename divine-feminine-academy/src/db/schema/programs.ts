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

export const cohorts = pgTable(
  'cohorts',
  {
    id: primaryId(),
    programId: uuid('program_id')
      .notNull()
      .references(() => programs.id, { onDelete: 'cascade' }),
    versionId: uuid('version_id').references(() => programVersions.id),
    name: text('name').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    capacity: integer('capacity'),
    ...timestamps,
  },
  (t) => [index('cohorts_program_idx').on(t.programId, t.startsAt)],
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
