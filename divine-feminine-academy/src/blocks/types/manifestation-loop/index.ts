/** Day 4 — REVIEW THE BELIEF. */
import type { BlockDefinition } from '../../contract'
import { ManifestationLoopMember } from './Member'
import { configSchema, responseSchema, type Response } from './schema'

export const manifestationLoop: BlockDefinition<typeof configSchema, Response> = {
  type: 'manifestation_loop',
  label: 'The loop',
  description:
    'Experience, meaning, belief, expectation, attention, evidence — walked one step per screen with her own example. Encrypted.',
  configSchema,
  responseSchema,
  Member: ManifestationLoopMember,
  isSensitive: true,
  writesTo: ['journal_entries'],
}
