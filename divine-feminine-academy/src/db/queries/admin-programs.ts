import 'server-only'

import { asc, desc, eq, sql } from 'drizzle-orm'
import {
  cohorts,
  enrollments,
  lessonBlocks,
  lessons,
  modules,
  programVersions,
  programs,
} from '../schema'
import { policy, require_ } from '@/lib/permissions/policy'
import type { QueryContext } from './_context'

/** Every programme, with its draft/published state and enrollment count. */
export async function listPrograms({ db, actor }: QueryContext) {
  require_(policy.program.readDraft(actor))

  const rows = await db
    .select({
      program: programs,
      enrollmentCount: sql<number>`(
        SELECT count(*) FROM ${enrollments} WHERE ${enrollments.programId} = ${programs.id}
      )`,
      latestVersion: sql<number>`(
        SELECT coalesce(max(${programVersions.version}), 0)
        FROM ${programVersions} WHERE ${programVersions.programId} = ${programs.id}
      )`,
    })
    .from(programs)
    .orderBy(desc(programs.createdAt))

  return rows.map((r) => ({
    ...r.program,
    enrollmentCount: Number(r.enrollmentCount),
    latestVersion: Number(r.latestVersion),
  }))
}

/** One programme with its newest version's full structure. */
export async function getProgramForBuilder(
  { db, actor }: QueryContext,
  programId: string,
) {
  require_(policy.program.readDraft(actor))

  const [program] = await db
    .select()
    .from(programs)
    .where(eq(programs.id, programId))
    .limit(1)

  if (!program) return null

  const versions = await db
    .select()
    .from(programVersions)
    .where(eq(programVersions.programId, programId))
    .orderBy(desc(programVersions.version))

  const current = versions[0]
  if (!current) return { program, versions, days: [] }

  const rows = await db
    .select({ module: modules, lesson: lessons, block: lessonBlocks })
    .from(modules)
    .leftJoin(lessons, eq(lessons.moduleId, modules.id))
    .leftJoin(lessonBlocks, eq(lessonBlocks.lessonId, lessons.id))
    .where(eq(modules.versionId, current.id))
    .orderBy(asc(modules.position), asc(lessons.position), asc(lessonBlocks.position))

  // Fold the join back into days -> lessons -> blocks.
  const days = new Map<
    string,
    {
      module: typeof modules.$inferSelect
      lessons: Map<
        string,
        {
          lesson: typeof lessons.$inferSelect
          blocks: (typeof lessonBlocks.$inferSelect)[]
        }
      >
    }
  >()

  for (const row of rows) {
    const day = days.get(row.module.id) ?? { module: row.module, lessons: new Map() }
    days.set(row.module.id, day)

    if (!row.lesson) continue
    const lesson = day.lessons.get(row.lesson.id) ?? { lesson: row.lesson, blocks: [] }
    day.lessons.set(row.lesson.id, lesson)

    if (row.block) lesson.blocks.push(row.block)
  }

  return {
    program,
    versions,
    currentVersion: current,
    days: [...days.values()].map((d) => ({
      module: d.module,
      lessons: [...d.lessons.values()],
    })),
  }
}

/**
 * Whether a version is safe to edit in place.
 *
 * Editing content that women are actively working through would shift the
 * ground under them, so the builder refuses and offers a new version instead.
 */
export async function versionIsInUse(
  db: QueryContext['db'],
  versionId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(enrollments)
    .where(eq(enrollments.versionId, versionId))
  return Number(row?.n ?? 0) > 0
}

export async function listCohorts(
  { db, actor }: QueryContext,
  programId: string,
) {
  require_(policy.program.readDraft(actor))
  return db
    .select()
    .from(cohorts)
    .where(eq(cohorts.programId, programId))
    .orderBy(asc(cohorts.startsAt))
}
