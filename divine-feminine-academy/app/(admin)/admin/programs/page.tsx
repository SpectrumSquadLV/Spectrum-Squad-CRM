import Link from 'next/link'
import { Badge, Button } from '@/design-system/primitives'
import { listPrograms } from '@/db/queries/admin-programs'
import { getQueryContext } from '@/lib/auth/actor-server'

export const metadata = { title: 'Programs' }

export default async function ProgramsPage() {
  const ctx = await getQueryContext()
  const programs = await listPrograms(ctx)

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 md:px-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-lg font-semibold">Programs</h1>
        <Button size="sm" asChild>
          <Link href="/admin/programs/new">New program</Link>
        </Button>
      </div>

      {programs.length === 0 ? (
        <p className="mt-10 text-xs text-ink-muted">
          Nothing yet. A programme is days, and a day is blocks — no code
          involved.
        </p>
      ) : (
        <table className="mt-8 w-full border-collapse text-2xs">
          <thead>
            <tr className="border-b border-rule-strong text-left text-ink-muted">
              <th className="py-2 pr-4 font-medium">Program</th>
              <th className="py-2 pr-4 font-medium">Kind</th>
              <th className="py-2 pr-4 font-medium">Pacing</th>
              <th className="py-2 pr-4 font-medium">Days</th>
              <th className="py-2 pr-4 font-medium">Version</th>
              <th className="py-2 pr-4 font-medium">Enrolled</th>
              <th className="py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {programs.map((p) => (
              <tr key={p.id} className="border-b border-rule">
                <td className="py-3 pr-4">
                  <Link
                    href={`/admin/programs/${p.id}`}
                    className="text-xs text-ink hover:text-clay-deep"
                  >
                    {p.title}
                  </Link>
                  <span className="block text-ink-faint">/{p.slug}</span>
                </td>
                <td className="py-3 pr-4 text-ink-muted">{p.kind}</td>
                <td className="py-3 pr-4 text-ink-muted">
                  {p.pacing}
                  {p.allowEarlyUnlock ? ' · early unlock' : ''}
                </td>
                <td className="py-3 pr-4 text-ink-muted">{p.durationDays ?? '—'}</td>
                <td className="py-3 pr-4 text-ink-muted">v{p.latestVersion}</td>
                <td className="py-3 pr-4 text-ink-muted">{p.enrollmentCount}</td>
                <td className="py-3">
                  <Badge
                    className={
                      p.status === 'published'
                        ? 'border-positive/40 text-positive'
                        : undefined
                    }
                  >
                    {p.status}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
