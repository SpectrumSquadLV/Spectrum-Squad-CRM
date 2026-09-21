import Link from 'next/link'
import { Badge, Input } from '@/design-system/primitives'
import { listStages, searchContacts } from '@/db/queries/crm'
import { formatMoney } from '@/features/commerce/pricing'
import { getQueryContext } from '@/lib/auth/actor-server'

export const metadata = { title: 'Contacts' }

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[]; stage?: string | string[] }>
}) {
  const params = await searchParams
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
  const query = one(params.q)
  const stageId = one(params.stage)

  const ctx = await getQueryContext()
  const [rows, stages] = await Promise.all([
    searchContacts(ctx, { query, stageId }),
    listStages(ctx),
  ])

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 md:px-8">
      <h1 className="text-lg font-semibold">Contacts</h1>

      <form className="mt-6 flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1">
          <label htmlFor="q" className="block text-2xs text-ink-muted">
            Search
          </label>
          <Input
            id="q"
            name="q"
            defaultValue={query}
            placeholder="Name or email"
            className="mt-1"
          />
        </div>
        <div>
          <label htmlFor="stage" className="block text-2xs text-ink-muted">
            Stage
          </label>
          <select
            id="stage"
            name="stage"
            defaultValue={stageId ?? ''}
            className="mt-1 min-h-12 rounded-md border border-rule-strong bg-alabaster px-3 text-sm"
          >
            <option value="">Any</option>
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          className="min-h-12 rounded-md border border-rule-strong bg-alabaster px-5 text-xs hover:border-clay"
        >
          Filter
        </button>
      </form>

      {rows.length === 0 ? (
        <p className="mt-10 text-xs text-ink-muted">Nobody matches that.</p>
      ) : (
        <table className="mt-8 w-full border-collapse text-2xs">
          <thead>
            <tr className="border-b border-rule-strong text-left text-ink-muted">
              <th className="py-2 pr-4 font-medium">Name</th>
              <th className="py-2 pr-4 font-medium">Stage</th>
              <th className="py-2 pr-4 font-medium">Source</th>
              <th className="py-2 pr-4 font-medium">Programs</th>
              <th className="py-2 pr-4 font-medium">HER choices</th>
              <th className="py-2 pr-4 font-medium">Spent</th>
              <th className="py-2 font-medium">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ contact, stageName, enrollmentCount, choiceCount }) => (
              <tr key={contact.id} className="border-b border-rule">
                <td className="py-3 pr-4">
                  <Link
                    href={`/admin/contacts/${contact.id}`}
                    className="text-xs text-ink hover:text-clay-deep"
                  >
                    {[contact.firstName, contact.lastName].filter(Boolean).join(' ') ||
                      '—'}
                  </Link>
                  <span className="block text-ink-faint">{contact.email}</span>
                </td>
                <td className="py-3 pr-4">
                  {stageName ? <Badge>{stageName}</Badge> : '—'}
                </td>
                <td className="py-3 pr-4 text-ink-muted">
                  {contact.acquisitionSource ?? '—'}
                </td>
                <td className="py-3 pr-4 text-ink-muted">{Number(enrollmentCount)}</td>
                <td className="py-3 pr-4 text-ink-muted">{Number(choiceCount)}</td>
                <td className="py-3 pr-4 text-ink-muted">
                  {formatMoney(contact.lifetimeValueCents)}
                </td>
                <td className="py-3 text-ink-muted">
                  {contact.lastActivityAt
                    ? contact.lastActivityAt.toLocaleDateString('en-US')
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
