import Link from 'next/link'
import { ProgramForm } from '@/features/admin/ProgramForm'

export const metadata = { title: 'New program' }

export default function NewProgramPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 md:px-8">
      <Link href="/admin/programs" className="text-2xs text-ink-muted">
        ← Programs
      </Link>
      <h1 className="mt-4 text-lg font-semibold">New program</h1>
      <p className="mt-2 max-w-lg text-2xs text-ink-muted">
        This creates the programme and its first draft version. Add days and
        blocks next, then publish when it is ready.
      </p>

      <div className="mt-8">
        <ProgramForm />
      </div>
    </div>
  )
}
