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
  /**
   * Some blocks show a woman her own data rather than asking for more of it -
   * Day 7 reads her week back to her. The day runner resolves this on the
   * server and hands it to the block as `context`.
   */
  resolvesContext?: 'her_evidence'
  /** Where this block writes, beyond block_responses. */
  writesTo?: Array<
    | 'her_patterns'
    | 'her_choices'
    | 'her_desires'
    | 'her_codes'
    | 'journal_entries'
    | 'mirror_sessions'
    | 'me_retirement'
  >
}

export interface BlockMemberProps<Config, Response> {
  blockId: string
  config: Config
  /** Undefined until she has answered. */
  value: Response | undefined
  onChange: (value: Response) => void
  disabled?: boolean
  /** Server-resolved data, for blocks that declare `resolvesContext`. */
  context?: HerEvidence
}

/** What Day 7 reads back to her: her own week, in her own words. */
export interface HerEvidence {
  patterns: Array<{
    triggerText: string
    currentResponse: string | null
    herResponse: string | null
  }>
  choiceCount: number
  choices: Array<{
    situation: string | null
    herResponse: string | null
    area: string | null
  }>
  daysCompleted: number
  journalEntryCount: number
  journalWordCount: number
}

/**
 * The registry holds definitions of differing shapes, so it is typed loosely
 * on purpose. Each definition is still strictly typed at its own definition
 * site, which is where mistakes actually happen.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export type AnyBlockDefinition = BlockDefinition<z.ZodType<any>, any>
