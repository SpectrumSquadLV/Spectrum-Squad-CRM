/** Days 1 and 4 - the behaviours she recognises. */
import type { BlockDefinition } from '../../contract'
import { PatternSelectMember } from './Member'
import { configSchema, responseSchema, type Response } from './schema'

export const patternSelect: BlockDefinition<typeof configSchema, Response> = {
  type: 'pattern_select',
  label: 'Pattern select',
  description:
    'Tappable behaviours, multi-select, plus write-your-own. A flat list, or one list per area.',
  configSchema,
  responseSchema,
  Member: PatternSelectMember,
  /*
   * Sensitive, and it is worth being clear why, because these are phrases SHE
   * WAS OFFERED rather than sentences she composed. What makes them hers is
   * the set: which nine of the seventeen a woman taps is a more precise
   * portrait than most of what she would write in a box, and it is not
   * something an admin surface has any reason to read.
   */
  isSensitive: true,
  writesTo: ['her_patterns'],
}
