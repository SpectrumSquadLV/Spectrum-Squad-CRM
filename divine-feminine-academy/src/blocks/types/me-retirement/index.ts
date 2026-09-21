/** Day 7 — retiring ME. */
import type { BlockDefinition } from '../../contract'
import { MeRetirementMember } from './Member'
import { configSchema, responseSchema, type Response } from './schema'

export const meRetirement: BlockDefinition<typeof configSchema, Response> = {
  type: 'me_retirement',
  label: 'Retiring ME',
  description:
    'Day 7. Understand her, love her, thank her, release her — then HER LEADS NOW. Marks her patterns retired.',
  configSchema,
  responseSchema,
  Member: MeRetirementMember,
  isSensitive: true,
  writesTo: ['journal_entries', 'me_retirement'],
}
