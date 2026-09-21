'use client'

import { useState } from 'react'
import { Button } from '@/design-system/primitives'
import { cn } from '@/lib/utils/cn'

/** Copy the link, or hand off to the native share sheet on a phone. */
export function ShareRow({ url, className }: { url: string; className?: string }) {
  const [copied, setCopied] = useState(false)

  async function share() {
    if (typeof navigator !== 'undefined' && 'share' in navigator) {
      try {
        await navigator.share({ title: 'My HER Code', url })
        return
      } catch {
        // She dismissed the sheet, or it is unavailable. Fall through to copy.
      }
    }
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-3', className)}>
      <Button type="button" onClick={share}>
        {copied ? 'Link copied' : 'Share'}
      </Button>
      <code className="truncate text-2xs text-ink-faint">{url}</code>
    </div>
  )
}
