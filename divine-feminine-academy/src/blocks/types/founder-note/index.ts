/** Quiana, in her own voice, immediately before a mirror. */
import type { BlockDefinition } from '../../contract'
import { FounderNoteMember } from './Member'
import { configSchema } from './schema'

export const founderNote: BlockDefinition<typeof configSchema, undefined> = {
  type: 'founder_note',
  label: 'A note from Quiana',
  description:
    'Her voice, with her photograph, before a mirror. The words live in founder-notes.ts, not in this block.',
  configSchema,
  // Display-only. She is being spoken to, not asked for anything.
  responseSchema: null,
  Member: FounderNoteMember,
  isSensitive: false,
  resolvesContext: 'founder_portrait',
}
