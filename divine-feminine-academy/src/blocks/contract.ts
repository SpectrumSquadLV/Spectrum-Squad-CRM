import type { FunctionComponent } from 'react'
import type { z } from 'zod'

/**
 * A block definition.
 *
 * One folder per block type under ./types, each exporting one of these.
 * Adding block type number nineteen touches nothing else in the codebase.
 *
 * `Response` is the block's answer shape, or `undefined` for display-only.
 */
export interface BlockDefinition<
  Config extends z.ZodTypeAny = z.ZodTypeAny,
  Response = unknown,
> {
  /** Stable identifier stored in lesson_blocks.type. Never rename in place. */
  type: string
  /** Shown in the admin block palette. */
  label: string
  description: string
  /** Validates lesson_blocks.config. */
  configSchema: Config
  /** Validates block_responses.response. Null for display-only blocks. */
  responseSchema: z.ZodType<Response> | null
  /** What a woman sees inside a lesson. */
  Member: FunctionComponent<BlockMemberProps<z.infer<Config>, Response>>
  /**
   * Sensitive block responses are encrypted exactly like journal bodies, and
   * admin surfaces see only that the block was answered.
   */
  isSensitive: boolean
  /** Where this block writes, beyond block_responses. */
  writesTo?: Array<
    | 'her_patterns'
    | 'her_choices'
    | 'return_sessions'
    | 'her_codes'
    | 'journal_entries'
  >
}

export interface BlockMemberProps<Config, Response> {
  blockId: string
  config: Config
  /** Undefined until she has answered. */
  value: Response | undefined
  onChange: (value: Response) => void
  disabled?: boolean
}

/**
 * The registry holds definitions of differing shapes, so it is typed loosely
 * on purpose. Each definition is still strictly typed at its own definition
 * site, which is where mistakes actually happen.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export type AnyBlockDefinition = BlockDefinition<z.ZodType<any>, any>
