/** Her own words, on a later day. */
import type { BlockDefinition } from '../../contract'
import { CallbackMember } from './Member'
import { configSchema } from './schema'

export const callback: BlockDefinition<typeof configSchema, undefined> = {
  type: 'callback',
  label: 'Her own words',
  description:
    'Display only. Reads something she wrote on an earlier day back to her.',
  configSchema,
  responseSchema: null,
  Member: CallbackMember,
  isSensitive: false,
  resolvesContext: 'her_evidence',
}
