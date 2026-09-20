import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Admin',
  robots: { index: false, follow: false },
}

/** The Console surface: denser, plainer, no display type. */
export default function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <div className="surface-console min-h-screen bg-bone">{children}</div>
}
