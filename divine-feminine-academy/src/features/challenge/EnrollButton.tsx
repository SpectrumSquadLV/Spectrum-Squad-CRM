'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'
import { Button } from '@/design-system/primitives'
import { enroll } from './actions'

export function EnrollButton({
  programSlug,
  className,
}: {
  programSlug: string
  className?: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  return (
    <Button
      size="lg"
      className={className}
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await enroll(programSlug)
          if (!result.error) router.push(`/my-academy/${programSlug}/day/1`)
        })
      }
    >
      {pending ? 'Opening…' : 'Begin Day 1'}
    </Button>
  )
}
