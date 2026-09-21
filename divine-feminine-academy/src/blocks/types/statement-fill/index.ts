/** Day 3 - LOVE ME. The statement she makes to ME. */
import type { BlockDefinition } from '../../contract'
import { StatementFillMember } from './Member'
import { configSchema, responseSchema, type Response } from './schema'

export const statementFill: BlockDefinition<typeof configSchema, Response> = {
  type: 'statement_fill',
  label: 'Statement',
  description:
    'A sentence she completes, with some parts filled from her earlier answers. Each blank is stored separately.',
  configSchema,
  responseSchema,
  Member: StatementFillMember,
  isSensitive: true,
  writesTo: ['journal_entries'],
}
