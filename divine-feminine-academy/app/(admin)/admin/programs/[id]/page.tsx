import Link from 'next/link'
import { notFound } from 'next/navigation'
import { db } from '@/db/client'
import { Badge, Rule } from '@/design-system/primitives'
import { getBlock } from '@/blocks/registry'
import { getProgramForBuilder, versionIsInUse } from '@/db/queries/admin-programs'
import type { EditableBlock } from '@/features/admin/BlockEditor'
import { DayBuilder } from '@/features/admin/DayBuilder'
import { ProgramActionsBar } from '@/features/admin/ProgramActionsBar'
import { ProgramForm } from '@/features/admin/ProgramForm'
import { blockPalette } from '@/features/admin/program-actions'
import { getQueryContext } from '@/lib/auth/actor-server'

export const metadata = { title: 'Program' }

export default async function ProgramBuilderPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const ctx = await getQueryContext()
  const data = await getProgramForBuilder(ctx, id)
  if (!data) notFound()

  const { program, versions, days } = data
  const current = 'currentVersion' in data ? data.currentVersion : undefined
  const locked = current ? await versionIsInUse(db, current.id) : false
  const palette = await blockPalette()

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 md:px-8">
      <Link href="/admin/programs" className="text-2xs text-ink-muted">
        ← Programs
      </Link>

      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">{program.title}</h1>
          <p className="mt-1 text-2xs text-ink-faint">
            /{program.slug} · v{current?.version ?? 0} ·{' '}
            {versions.length} version{versions.length === 1 ? '' : 's'}
          </p>
        </div>
        <Badge
          className={
            program.status === 'published'
              ? 'border-positive/40 text-positive'
              : undefined
          }
        >
          {program.status}
        </Badge>
      </div>

      {locked && (
        <p className="mt-6 rounded-md border border-caution/40 bg-caution/5 px-4 py-3 text-2xs text-caution">
          Women are working through version {current?.version}. Its structure is
          locked so the ground does not shift under them — publish to create
          version {(current?.version ?? 0) + 1} and edit that instead.
        </p>
      )}

      <Rule className="my-8" />

      <section>
        <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-muted">
          Settings
        </h2>
        <div className="mt-5">
          <ProgramForm
            programId={program.id}
            defaults={{
              title: program.title,
              subtitle: program.subtitle ?? '',
              description: program.description ?? '',
              kind: program.kind,
              pacing: program.pacing,
              allowEarlyUnlock: program.allowEarlyUnlock,
            }}
          />
        </div>
      </section>

      <Rule className="my-8" />

      <section>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-muted">
            Days
          </h2>
          <ProgramActionsBar programId={program.id} locked={locked} />
        </div>

        {days.length === 0 ? (
          <p className="mt-6 text-2xs text-ink-muted">
            No days yet. Add one, then fill it with blocks.
          </p>
        ) : (
          <div className="mt-6 flex flex-col gap-6">
            {days.map((day) => {
              const lesson = day.lessons[0]
              const blocks: EditableBlock[] = (lesson?.blocks ?? []).map((b) => {
                const definition = getBlock(b.type)
                return {
                  id: b.id,
                  type: b.type,
                  config: (b.config ?? {}) as Record<string, unknown>,
                  isRequired: b.isRequired,
                  position: b.position,
                  label: definition?.label ?? b.type,
                  description: definition?.description ?? 'Unknown block type.',
                  isSensitive: definition?.isSensitive ?? false,
                  takesAnswer: Boolean(definition?.responseSchema),
                  known: Boolean(definition),
                }
              })

              return (
                <DayBuilder
                  key={day.module.id}
                  programId={program.id}
                  moduleId={day.module.id}
                  lessonId={lesson?.lesson.id ?? null}
                  position={day.module.position}
                  title={day.module.title}
                  subtitle={day.module.subtitle}
                  blocks={blocks}
                  palette={palette}
                  locked={locked}
                />
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
