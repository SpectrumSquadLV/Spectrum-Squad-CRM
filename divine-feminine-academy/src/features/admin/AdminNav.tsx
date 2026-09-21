'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils/cn'

const links = [
  { href: '/admin', label: 'Overview', exact: true },
  { href: '/admin/audience', label: 'Audience' },
  { href: '/admin/contacts', label: 'Contacts' },
  { href: '/admin/pipeline', label: 'Pipeline' },
  { href: '/admin/programs', label: 'Programs' },
  { href: '/admin/writing', label: 'Writing' },
  { href: '/admin/images', label: 'Photographs' },
  { href: '/admin/offers', label: 'Offers' },
  { href: '/admin/orders', label: 'Orders' },
  { href: '/admin/analytics', label: 'Analytics' },
  { href: '/admin/automations', label: 'Automations' },
  { href: '/admin/assessments', label: 'Assessments' },
  { href: '/admin/certificates', label: 'Certificates' },
  { href: '/admin/design', label: 'Design' },
]

export function AdminNav({ canManageRoles }: { canManageRoles: boolean }) {
  const pathname = usePathname()

  return (
    <header className="border-b border-rule bg-alabaster">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 md:px-8">
        <Link href="/admin" className="text-xs font-semibold tracking-tight">
          Divine Feminine Admin
        </Link>

        <nav aria-label="Admin" className="flex flex-wrap items-center gap-x-5 gap-y-1">
          {links.map((l) => {
            const active = l.exact
              ? pathname === l.href
              : pathname.startsWith(l.href)
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'inline-flex min-h-9 items-center text-2xs transition-colors',
                  active ? 'text-ink' : 'text-ink-muted hover:text-ink',
                )}
              >
                {l.label}
              </Link>
            )
          })}
          {canManageRoles && (
            <Link
              href="/admin/audit-log"
              className="inline-flex min-h-9 items-center text-2xs text-ink-muted hover:text-ink"
            >
              Audit log
            </Link>
          )}
        </nav>

        <Link
          href="/my-academy"
          className="ml-auto inline-flex min-h-9 items-center text-2xs text-ink-muted hover:text-ink"
        >
          Leave admin
        </Link>
      </div>
    </header>
  )
}
