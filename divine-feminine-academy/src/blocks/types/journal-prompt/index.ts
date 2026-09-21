import type { BlockDefinition } from '../../contract'
import { JournalPromptMember } from './Member'
import { configSchema, responseSchema, type Response } from './schema'

export const journalPrompt: BlockDefinition<typeof configSchema, Response> = {
  type: 'journal_prompt',
  label: 'Journal prompt',
  description: 'A prompted free write that lands in her journal. Encrypted.',
  configSchema,
  responseSchema,
  Member: JournalPromptMember,
  isSensitive: true,
  writesTo: ['journal_entries'],
}
