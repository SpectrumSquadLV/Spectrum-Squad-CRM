/** Day 3. Server-readable definition. */
import type { BlockDefinition } from '../../contract'
import { ValidationAuditMember } from './Member'
import { configSchema, responseSchema, type Response } from './schema'

export const validationAudit: BlockDefinition<typeof configSchema, Response> = {
  type: 'validation_audit',
  label: 'Validation audit',
  description:
    'Whose approval she is still arranging her life around. Encrypted; only she can read it.',
  configSchema,
  responseSchema,
  Member: ValidationAuditMember,
  isSensitive: true,
  writesTo: ['journal_entries'],
}
