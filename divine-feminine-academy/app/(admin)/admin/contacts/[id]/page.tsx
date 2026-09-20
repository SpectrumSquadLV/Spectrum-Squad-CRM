import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Badge, Rule } from '@/design-system/primitives'
import { getContactDetail, listStages } from '@/db/queries/crm'
import {
  FollowUpsPanel,
  NotesPanel,
  StagePicker,
  TagsPanel,
} from '@/features/admin/ContactPanels'
import { formatMoney } from '@/features/commerce/pricing'
import { getQueryContext } from '@/lib/auth/actor-server'

export const metadata = { title: 'Contact' }

/**
 * One woman, as staff sees her.
 *
 * Source, spend, progress, HER choice count, notes, last activity — and NOT
 * ONE WORD of her journal. The journal block below shows entry count, word
 * count and when she last wrote; the query behind it never selects the
 * ciphertext column, and nothing on this page can decrypt it.
 */
export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const ctx = await getQueryContext()
  const [detail, stages] = await Promise.all([
    getContactDetail(ctx, id),
    listStages(ctx),
  ])
  if (!detail) notFound()

  const { contact, stage, journal } = detail
  const name =
    [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.email

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 md:px-8">
      <Link href="/admin/contacts" className="text-2xs text-ink-muted">
        ← Contacts
      </Link>

      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">{name}</h1>
          <p className="mt-1 text-2xs text-ink-faint">
            {contact.email}
            {contact.phone ? ` · ${contact.phone}` : ''} · {contact.timezone}
          </p>
        </div>
        <StagePicker
          contactId={contact.id}
          stages={stages}
          currentStageId={stage?.id ?? null}
        />
      </div>

      <dl className="mt-8 grid grid-cols-2 gap-px border border-rule bg-rule sm:grid-cols-4">
        {[
          { label: 'Lifetime value', value: formatMoney(contact.lifetimeValueCents) },
          { label: 'Programs', value: String(detail.enrollments.length) },
          { label: 'HER choices', value: String(detail.herChoiceCount) },
          { label: 'Certificates', value: String(detail.certificates.length) },
        ].map((s) => (
          <div key={s.label} className="bg-alabaster p-4">
            <dd className="font-display text-2xl leading-none">{s.value}</dd>
            <dt className="mt-2 text-2xs text-ink-muted">{s.label}</dt>
          </div>
        ))}
      </dl>

      <p className="mt-4 text-2xs text-ink-muted">
        Source: {contact.acquisitionSource ?? 'unknown'}
        {contact.utmCampaign ? ` · campaign ${contact.utmCampaign}` : ''} · first
        seen {contact.leadAt.toLocaleDateString('en-US')}
      </p>

      <Rule className="my-8" />

      <div className="grid gap-10 lg:grid-cols-2">
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-muted">
            Progress
          </h2>
          {detail.enrollments.length === 0 ? (
            <p className="mt-4 text-2xs text-ink-muted">Not enrolled in anything.</p>
          ) : (
            <ul className="mt-4 divide-y divide-rule border-y border-rule">
              {detail.enrollments.map(({ enrollment, programTitle }) => (
                <li key={enrollment.id} className="flex items-center justify-between gap-3 py-3">
                  <span className="text-xs">{programTitle}</span>
                  <span className="flex items-center gap-2 text-2xs text-ink-muted">
                    <Badge
                      className={
                        enrollment.status === 'completed'
                          ? 'border-positive/40 text-positive'
                          : undefined
                      }
                    >
                      {enrollment.status}
                    </Badge>
                    day {enrollment.currentDay}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {detail.certificates.length > 0 && (
            <ul className="mt-5 space-y-1">
              {detail.certificates.map(({ certificate, programTitle }) => (
                <li key={certificate.id} className="text-2xs text-ink-muted">
                  <Link
                    href={`/verify/${certificate.verificationToken}`}
                    className="font-mono text-clay-deep underline underline-offset-4"
                  >
                    {certificate.certificateNumber}
                  </Link>{' '}
                  — {programTitle}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-muted">
            Journal
          </h2>
          <div className="mt-4 rounded-md border border-plum/30 bg-plum-wash/40 p-4">
            <p className="text-xs text-plum">
              {journal.entries} entr{journal.entries === 1 ? 'y' : 'ies'} ·{' '}
              {journal.words.toLocaleString()} words
              {journal.lastAt
                ? ` · last wrote ${journal.lastAt.toLocaleDateString('en-US')}`
                : ''}
            </p>
            <p className="mt-2 text-2xs text-ink-muted">
              Her entries are encrypted with a key belonging to her account.
              Nobody here can read them — not support, not the founder. This is
              engagement only.
            </p>
          </div>

          <h2 className="mt-8 text-xs font-semibold uppercase tracking-[0.14em] text-ink-muted">
            Orders
          </h2>
          {detail.orders.length === 0 ? (
            <p className="mt-4 text-2xs text-ink-muted">Nothing purchased.</p>
          ) : (
            <ul className="mt-4 divide-y divide-rule border-y border-rule">
              {detail.orders.map((order) => (
                <li key={order.id} className="flex items-center justify-between gap-3 py-3">
                  <span className="text-2xs text-ink-muted">
                    {order.placedAt.toLocaleDateString('en-US')}
                  </span>
                  <span className="flex items-center gap-3">
                    <Badge
                      className={
                        order.status === 'paid'
                          ? 'border-positive/40 text-positive'
                          : order.status === 'refunded'
                            ? 'border-critical/40 text-critical'
                            : undefined
                      }
                    >
                      {order.status}
                    </Badge>
                    <span className="text-xs">
                      {formatMoney(order.totalCents, order.currency)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <Rule className="my-10" />

      <div className="grid gap-10 lg:grid-cols-2">
        <NotesPanel contactId={contact.id} notes={detail.notes} />
        <div className="flex flex-col gap-10">
          <FollowUpsPanel contactId={contact.id} followUps={detail.followUps} />
          <TagsPanel contactId={contact.id} tags={detail.tags} />
        </div>
      </div>

      {detail.history.length > 0 && (
        <>
          <Rule className="my-10" />
          <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-muted">
            How she got here
          </h2>
          <ul className="mt-4 space-y-1">
            {detail.history.map(({ entry, toName }) => (
              <li key={entry.id} className="text-2xs text-ink-muted">
                {entry.changedAt.toLocaleDateString('en-US')} — moved to{' '}
                {toName ?? 'a stage'}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
