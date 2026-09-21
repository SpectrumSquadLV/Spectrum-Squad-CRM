'use server'

import { and, desc, eq, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/db/client'
import {
  auditLog,
  lessonBlocks,
  lessons,
  modules,
  programVersions,
  programs,
} from '@/db/schema'
import { getBlock, listBlocks } from '@/blocks/registry'
import { versionIsInUse } from '@/db/queries/admin-programs'
import { getActor } from '@/lib/auth/actor-server'
import { isAdmin, type Actor } from '@/lib/permissions/actor'

export type BuilderState = { ok?: boolean; error?: string; id?: string }

/** Every write here is admin-only, and every write is audited. */
async function requireAdmin(): Promise<Actor | null> {
  const actor = await getActor()
  return isAdmin(actor) ? actor : null
}

async function audit(
  actor: Actor,
  action: string,
  entity: string,
  entityId: string | null,
  metadata: Record<string, unknown> = {},
) {
  await db.insert(auditLog).values({
    actorUserId: actor.kind === 'user' ? actor.userId : null,
    action,
    entity,
    entityId,
    metadata,
  })
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)

const programSchema = z.object({
  title: z.string().trim().min(1, 'Give it a name.').max(160),
  subtitle: z.string().trim().max(240).optional(),
  description: z.string().trim().max(4000).optional(),
  kind: z.enum(['challenge', 'course', 'program', 'membership']),
  pacing: z.enum(['immediate', 'drip', 'cohort', 'date_based']),
  allowEarlyUnlock: z.union([z.literal('on'), z.literal('')]).optional(),
})

export async function createProgram(
  _prev: BuilderState,
  formData: FormData,
): Promise<BuilderState> {
  const actor = await requireAdmin()
  if (!actor) return { error: 'You do not have access to that.' }

  const parsed = programSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the fields.' }
  }
  const input = parsed.data

  let slug = slugify(input.title)
  const [clash] = await db
    .select({ id: programs.id })
    .from(programs)
    .where(eq(programs.slug, slug))
    .limit(1)
  if (clash) slug = `${slug}-${Date.now().toString(36).slice(-4)}`

  const [program] = await db
    .insert(programs)
    .values({
      slug,
      title: input.title,
      subtitle: input.subtitle || null,
      description: input.description || null,
      kind: input.kind,
      pacing: input.pacing,
      allowEarlyUnlock: input.allowEarlyUnlock === 'on',
      status: 'draft',
    })
    .returning()

  if (!program) return { error: 'That did not save.' }

  // A programme is unusable without a version to hang days on.
  await db.insert(programVersions).values({ programId: program.id, version: 1 })

  await audit(actor, 'program.created', 'programs', program.id, { slug })
  revalidatePath('/admin/programs')
  return { ok: true, id: program.id }
}

export async function updateProgram(
  programId: string,
  formData: FormData,
): Promise<BuilderState> {
  const actor = await requireAdmin()
  if (!actor) return { error: 'You do not have access to that.' }

  const parsed = programSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the fields.' }
  }
  const input = parsed.data

  await db
    .update(programs)
    .set({
      title: input.title,
      subtitle: input.subtitle || null,
      description: input.description || null,
      kind: input.kind,
      pacing: input.pacing,
      allowEarlyUnlock: input.allowEarlyUnlock === 'on',
      updatedAt: new Date(),
    })
    .where(eq(programs.id, programId))

  await audit(actor, 'program.updated', 'programs', programId)
  revalidatePath(`/admin/programs/${programId}`)
  return { ok: true }
}

/** The newest version, and whether it may be edited in place. */
async function editableVersion(programId: string) {
  const [version] = await db
    .select()
    .from(programVersions)
    .where(eq(programVersions.programId, programId))
    .orderBy(desc(programVersions.version))
    .limit(1)

  if (!version) return { version: null, locked: false }
  return { version, locked: await versionIsInUse(db, version.id) }
}

export async function addDay(programId: string): Promise<BuilderState> {
  const actor = await requireAdmin()
  if (!actor) return { error: 'You do not have access to that.' }

  const { version, locked } = await editableVersion(programId)
  if (!version) return { error: 'This programme has no version yet.' }
  if (locked) {
    return {
      error:
        'Women are working through this version. Publish a new version before editing it.',
    }
  }

  const [last] = await db
    .select({ n: sql<number>`coalesce(max(${modules.position}), 0)` })
    .from(modules)
    .where(eq(modules.versionId, version.id))

  const position = Number(last?.n ?? 0) + 1

  const [day] = await db
    .insert(modules)
    .values({ versionId: version.id, position, title: `Day ${position}` })
    .returning()

  if (!day) return { error: 'That did not save.' }

  // Every day needs one lesson to hold its blocks.
  await db.insert(lessons).values({
    moduleId: day.id,
    position: 1,
    title: `Day ${position}`,
  })

  await db
    .update(programs)
    .set({ durationDays: position, updatedAt: new Date() })
    .where(eq(programs.id, programId))

  await audit(actor, 'program.day_added', 'modules', day.id, { position })
  revalidatePath(`/admin/programs/${programId}`)
  return { ok: true, id: day.id }
}

const daySchema = z.object({
  title: z.string().trim().min(1).max(160),
  subtitle: z.string().trim().max(240).optional(),
})

export async function updateDay(
  programId: string,
  moduleId: string,
  formData: FormData,
): Promise<BuilderState> {
  const actor = await requireAdmin()
  if (!actor) return { error: 'You do not have access to that.' }

  const parsed = daySchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { error: 'Check the fields.' }

  await db
    .update(modules)
    .set({
      title: parsed.data.title,
      subtitle: parsed.data.subtitle || null,
      updatedAt: new Date(),
    })
    .where(eq(modules.id, moduleId))

  await audit(actor, 'program.day_updated', 'modules', moduleId)
  revalidatePath(`/admin/programs/${programId}`)
  return { ok: true }
}

export async function deleteDay(
  programId: string,
  moduleId: string,
): Promise<BuilderState> {
  const actor = await requireAdmin()
  if (!actor) return { error: 'You do not have access to that.' }

  const { version, locked } = await editableVersion(programId)
  if (!version) return { error: 'This programme has no version yet.' }
  if (locked) {
    return { error: 'Women are working through this version. Publish a new one first.' }
  }

  await db.delete(modules).where(eq(modules.id, moduleId))

  // Close the gap so day numbers stay contiguous; the drip counts on it.
  const remaining = await db
    .select()
    .from(modules)
    .where(eq(modules.versionId, version.id))
    .orderBy(modules.position)

  for (const [i, day] of remaining.entries()) {
    if (day.position !== i + 1) {
      await db
        .update(modules)
        .set({ position: i + 1 })
        .where(eq(modules.id, day.id))
    }
  }

  await db
    .update(programs)
    .set({ durationDays: remaining.length, updatedAt: new Date() })
    .where(eq(programs.id, programId))

  await audit(actor, 'program.day_deleted', 'modules', moduleId)
  revalidatePath(`/admin/programs/${programId}`)
  return { ok: true }
}

/**
 * Add a block from the registry palette.
 *
 * The type must exist in the registry, and its default config must satisfy
 * that type's own schema - so a block can never be created in a shape its
 * component cannot render.
 */
export async function addBlock(
  programId: string,
  lessonId: string,
  type: string,
): Promise<BuilderState> {
  const actor = await requireAdmin()
  if (!actor) return { error: 'You do not have access to that.' }

  const definition = getBlock(type)
  if (!definition) return { error: 'That block type does not exist.' }

  const { locked } = await editableVersion(programId)
  if (locked) {
    return { error: 'Women are working through this version. Publish a new one first.' }
  }

  // Seed with whatever the schema can default, plus placeholder text for the
  // fields it cannot.
  const seeded = definition.configSchema.safeParse({
    prompt: 'New prompt',
    body: 'New text',
    heading: '',
    title: definition.label,
    embedUrl: 'https://example.com/embed',
  })
  const config = seeded.success ? seeded.data : {}

  const [last] = await db
    .select({ n: sql<number>`coalesce(max(${lessonBlocks.position}), 0)` })
    .from(lessonBlocks)
    .where(eq(lessonBlocks.lessonId, lessonId))

  const [block] = await db
    .insert(lessonBlocks)
    .values({
      lessonId,
      position: Number(last?.n ?? 0) + 1,
      type,
      config,
      isRequired: false,
    })
    .returning()

  await audit(actor, 'program.block_added', 'lesson_blocks', block?.id ?? null, { type })
  revalidatePath(`/admin/programs/${programId}`)
  return { ok: true, id: block?.id }
}

/**
 * Save a block's config, validated against ITS OWN schema from the registry.
 *
 * This is what stops the builder producing content the day runner cannot
 * render: an invalid config is rejected here rather than blowing up in front
 * of a woman halfway through Day 3.
 */
export async function updateBlockConfig(
  programId: string,
  blockId: string,
  rawConfig: unknown,
  isRequired: boolean,
): Promise<BuilderState> {
  const actor = await requireAdmin()
  if (!actor) return { error: 'You do not have access to that.' }

  const [block] = await db
    .select()
    .from(lessonBlocks)
    .where(eq(lessonBlocks.id, blockId))
    .limit(1)
  if (!block) return { error: 'That block no longer exists.' }

  const definition = getBlock(block.type)
  if (!definition) return { error: 'That block type is no longer available.' }

  const parsed = definition.configSchema.safeParse(rawConfig)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return {
      error: issue
        ? `${issue.path.join('.') || 'config'}: ${issue.message}`
        : 'That configuration is not valid for this block.',
    }
  }

  await db
    .update(lessonBlocks)
    .set({ config: parsed.data, isRequired, updatedAt: new Date() })
    .where(eq(lessonBlocks.id, blockId))

  await audit(actor, 'program.block_updated', 'lesson_blocks', blockId, {
    type: block.type,
  })
  revalidatePath(`/admin/programs/${programId}`)
  return { ok: true }
}

export async function moveBlock(
  programId: string,
  blockId: string,
  direction: 'up' | 'down',
): Promise<BuilderState> {
  const actor = await requireAdmin()
  if (!actor) return { error: 'You do not have access to that.' }

  const [block] = await db
    .select()
    .from(lessonBlocks)
    .where(eq(lessonBlocks.id, blockId))
    .limit(1)
  if (!block) return { error: 'That block no longer exists.' }

  const siblings = await db
    .select()
    .from(lessonBlocks)
    .where(eq(lessonBlocks.lessonId, block.lessonId))
    .orderBy(lessonBlocks.position)

  const index = siblings.findIndex((b) => b.id === blockId)
  const swapWith = direction === 'up' ? index - 1 : index + 1
  const other = siblings[swapWith]
  if (index < 0 || !other) return { ok: true }

  // Park one position out of the way: (lesson, position) is unique.
  await db
    .update(lessonBlocks)
    .set({ position: -1 })
    .where(eq(lessonBlocks.id, block.id))
  await db
    .update(lessonBlocks)
    .set({ position: block.position })
    .where(eq(lessonBlocks.id, other.id))
  await db
    .update(lessonBlocks)
    .set({ position: other.position })
    .where(eq(lessonBlocks.id, block.id))

  revalidatePath(`/admin/programs/${programId}`)
  return { ok: true }
}

export async function deleteBlock(
  programId: string,
  blockId: string,
): Promise<BuilderState> {
  const actor = await requireAdmin()
  if (!actor) return { error: 'You do not have access to that.' }

  const { locked } = await editableVersion(programId)
  if (locked) {
    return { error: 'Women are working through this version. Publish a new one first.' }
  }

  const [block] = await db
    .select()
    .from(lessonBlocks)
    .where(eq(lessonBlocks.id, blockId))
    .limit(1)
  if (!block) return { ok: true }

  await db.delete(lessonBlocks).where(eq(lessonBlocks.id, blockId))

  const remaining = await db
    .select()
    .from(lessonBlocks)
    .where(eq(lessonBlocks.lessonId, block.lessonId))
    .orderBy(lessonBlocks.position)

  for (const [i, b] of remaining.entries()) {
    if (b.position !== i + 1) {
      await db
        .update(lessonBlocks)
        .set({ position: i + 1 })
        .where(eq(lessonBlocks.id, b.id))
    }
  }

  await audit(actor, 'program.block_deleted', 'lesson_blocks', blockId)
  revalidatePath(`/admin/programs/${programId}`)
  return { ok: true }
}

/**
 * Publish: copy the current version into a new one and mark it published.
 *
 * Copying rather than editing is the whole point of versioning. A woman on
 * Day 2 stays pinned to the version she enrolled in, and Day 3 does not change
 * underneath her.
 */
export async function publishVersion(programId: string): Promise<BuilderState> {
  const actor = await requireAdmin()
  if (!actor) return { error: 'You do not have access to that.' }

  const [source] = await db
    .select()
    .from(programVersions)
    .where(eq(programVersions.programId, programId))
    .orderBy(desc(programVersions.version))
    .limit(1)

  if (!source) return { error: 'This programme has no version to publish.' }

  const inUse = await versionIsInUse(db, source.id)

  // An untouched draft can simply be published in place.
  if (!inUse && !source.publishedAt) {
    await db
      .update(programVersions)
      .set({ publishedAt: new Date(), updatedAt: new Date() })
      .where(eq(programVersions.id, source.id))
    await db
      .update(programs)
      .set({ status: 'published', updatedAt: new Date() })
      .where(eq(programs.id, programId))

    await audit(actor, 'program.published', 'program_versions', source.id, {
      version: source.version,
    })
    revalidatePath(`/admin/programs/${programId}`)
    return { ok: true, id: source.id }
  }

  const [copy] = await db
    .insert(programVersions)
    .values({
      programId,
      version: source.version + 1,
      notes: `Copied from v${source.version}`,
      publishedAt: new Date(),
    })
    .returning()

  if (!copy) return { error: 'Could not create the new version.' }

  const sourceDays = await db
    .select()
    .from(modules)
    .where(eq(modules.versionId, source.id))
    .orderBy(modules.position)

  for (const day of sourceDays) {
    const [newDay] = await db
      .insert(modules)
      .values({
        versionId: copy.id,
        position: day.position,
        title: day.title,
        subtitle: day.subtitle,
      })
      .returning()
    if (!newDay) continue

    const sourceLessons = await db
      .select()
      .from(lessons)
      .where(eq(lessons.moduleId, day.id))
      .orderBy(lessons.position)

    for (const lesson of sourceLessons) {
      const [newLesson] = await db
        .insert(lessons)
        .values({
          moduleId: newDay.id,
          position: lesson.position,
          title: lesson.title,
          estimatedMinutes: lesson.estimatedMinutes,
        })
        .returning()
      if (!newLesson) continue

      const sourceBlocks = await db
        .select()
        .from(lessonBlocks)
        .where(eq(lessonBlocks.lessonId, lesson.id))
        .orderBy(lessonBlocks.position)

      for (const block of sourceBlocks) {
        await db.insert(lessonBlocks).values({
          lessonId: newLesson.id,
          position: block.position,
          type: block.type,
          config: block.config,
          isRequired: block.isRequired,
        })
      }
    }
  }

  await db
    .update(programs)
    .set({ status: 'published', durationDays: sourceDays.length, updatedAt: new Date() })
    .where(eq(programs.id, programId))

  await audit(actor, 'program.published', 'program_versions', copy.id, {
    version: copy.version,
    copiedFrom: source.version,
  })
  revalidatePath(`/admin/programs/${programId}`)
  return { ok: true, id: copy.id }
}

/** The palette the builder offers. */
export async function blockPalette() {
  return listBlocks().map((b) => ({
    type: b.type,
    label: b.label,
    description: b.description,
    isSensitive: b.isSensitive,
    takesAnswer: Boolean(b.responseSchema),
    writesTo: b.writesTo ?? [],
  }))
}
