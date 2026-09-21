/** Day 7 — the spoken mirror. */
import type { BlockDefinition } from '../../contract'
import { MirrorDeclarationMember } from './Member'
import { configSchema, responseSchema, type Response } from './schema'

export const mirrorDeclaration: BlockDefinition<typeof configSchema, Response> = {
  type: 'mirror_declaration',
  label: 'Mirror declaration',
  description:
    'Day 7 only. Builds her declaration from her own six days, lets her edit it, then a distraction-free screen to speak it out loud as HER.',
  configSchema,
  responseSchema,
  Member: MirrorDeclarationMember,
  isSensitive: true,
  // Built from her own week.
  resolvesContext: 'her_evidence',
  writesTo: ['journal_entries'],
}
