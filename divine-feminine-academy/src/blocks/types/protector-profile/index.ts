/** Day 2 — MEET YOUR PROTECTOR. */
import type { BlockDefinition } from '../../contract'
import { ProtectorProfileMember } from './Member'
import { configSchema, responseSchema, type Response } from './schema'

export const protectorProfile: BlockDefinition<typeof configSchema, Response> = {
  type: 'protector_profile',
  label: 'Meet your protector',
  description:
    'What ME has been protecting, what she feared, and what the job has cost. Encrypted.',
  configSchema,
  responseSchema,
  Member: ProtectorProfileMember,
  isSensitive: true,
  writesTo: ['journal_entries'],
}
