'use server'

import { optInInput, subscribeToArchetype } from './subscribe'

export type OptInState = { error?: string; done?: boolean }

/**
 * Join an archetype sequence from the page itself.
 *
 * A shell over `subscribeToArchetype`, for the same reason the quiz action is
 * a shell: the work has to be testable without a request.
 */
export async function optInToArchetype(
  _prev: OptInState,
  formData: FormData,
): Promise<OptInState> {
  const parsed = optInInput.safeParse({
    archetype: formData.get('archetype'),
    firstName: formData.get('firstName'),
    email: formData.get('email'),
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the fields.' }
  }

  const outcome = await subscribeToArchetype(parsed.data)
  if (!outcome.ok) return { error: outcome.error }

  // No redirect: she is reading a page about herself, and taking her off it to
  // say "thank you" would be worse than telling her here.
  return { done: true }
}
