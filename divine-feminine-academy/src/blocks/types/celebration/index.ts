/** Day 5's ending, and anywhere else a moment is earned. */
import type { BlockDefinition } from '../../contract'
import { CelebrationMember } from './Member'
import { configSchema } from './schema'

export const celebration: BlockDefinition<typeof configSchema, undefined> = {
  type: 'celebration',
  label: 'Celebration',
  description:
    'Display only. A moment built from her own numbers rather than confetti.',
  configSchema,
  responseSchema: null,
  Member: CelebrationMember,
  isSensitive: false,
  resolvesContext: 'her_evidence',
}
