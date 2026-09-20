import Link from 'next/link'

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-5 py-16">
      <Link href="/" className="mb-10 text-center font-display text-xl leading-none">
        Divine Feminine
        <span className="mt-1 block text-2xs uppercase tracking-[0.22em] text-clay-deep">
          Academy
        </span>
      </Link>
      <div className="w-full max-w-sm">{children}</div>
    </main>
  )
}
