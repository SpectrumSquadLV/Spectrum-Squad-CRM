/** Day 4 - RECOGNIZE WHAT ME HAS BEEN CREATING. */
import type { BlockDefinition } from '../../contract'
import { AreaPickerMember } from './Member'
import { configSchema, responseSchema, type Response } from './schema'

export const areaPicker: BlockDefinition<typeof configSchema, Response> = {
  type: 'area_picker',
  label: 'Area picker',
  description:
    'The four life areas as four large tiles. She chooses one to look at.',
  configSchema,
  responseSchema,
  Member: AreaPickerMember,
  // Which area she chose to look at is not a confession.
  isSensitive: false,
}
