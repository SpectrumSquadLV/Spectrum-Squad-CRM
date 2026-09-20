'use server'

import { joinCohortWaitlist, waitlistInput } from './waitlist'

export type WaitlistState = { error?: string; done?: boolean; alreadyOn?: boolean }

export async function joinWaitlist(
  _prev: WaitlistState,
  formData: FormData,
): Promise<WaitlistState> {
  const parsed = waitlistInput.safeParse({
    cohortId: formData.get('cohortId'),
    firstName: formData.get('firstName'),
    email: formData.get('email'),
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the fields.' }
  }

  const outcome = await joinCohortWaitlist(parsed.data)
  if (!outcome.ok) return { error: outcome.error }

  return { done: true, alreadyOn: outcome.alreadyOn }
}
