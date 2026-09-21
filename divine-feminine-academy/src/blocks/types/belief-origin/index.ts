/** Day 2. Server-readable definition; see dual-column-exercise/index.ts for why. */
import type { BlockDefinition } from '../../contract'
import { BeliefOriginMember } from './Member'
import { configSchema, responseSchema, type Response } from './schema'

export const beliefOrigin: BlockDefinition<typeof configSchema, Response> = {
  type: 'belief_origin',
  label: 'Belief and origin',
  description:
    'The belief underneath the pattern and where it started. Encrypted; only she can read it.',
  configSchema,
  responseSchema,
  Member: BeliefOriginMember,
  isSensitive: true,
  writesTo: ['journal_entries'],
}
