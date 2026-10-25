import type { FunctionComponent } from 'react'
import type { z } from 'zod'
import type { SlotImages } from '@/db/queries/images'
import type { Area } from '@/features/assessment/scoring'

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
  resolvesContext?: 'her_evidence' | 'founder_portrait'
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
  /**
   * Quiana's photograph, for blocks that declare `founder_portrait`.
   *
   * Separate from `context` rather than folded into it: the two are resolved
   * from different places for different reasons, and a union would make every
   * block that reads one narrow away the other before it could use it.
   *
   * Undefined when no block on the day asked for it; both crops null when she
   * has not uploaded one yet. A block must render without it.
   */
  portrait?: SlotImages
  /**
   * What she has already written TODAY, by the name each block saved under.
   *
   * The whole curriculum is built on one day being visibly aware of the last
   * screen: Day 1 reads her trigger back before asking what ME did, and Day 7
   * keeps ONE decision on screen across eight screens while she answers it
   * first as ME and then as HER. Without this a woman retypes her own
   * decision, and the day stops feeling like it is paying attention.
   *
   * Same-day only, and it lives in the runner's memory rather than the
   * database, so it is available before she has saved anything.
   */
  today?: Record<string, string>
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
  /**
   * What she allowed herself to want on Day 5, by area.
   *
   * Day 6 offers these back while she chooses one small thing, and Day 7 has
   * them available while she looks at a real decision through HER.
   */
  desires: Array<{ area: Area; text: string }>
  /**
   * Day 1's tags, in the second person: "prove yourself", "overthink".
   *
   * Day 3's statement reads "You learned to ___", so the tags are stored in
   * both forms and this is the one a sentence can actually use.
   */
  behaviorTags: string[]
  /** Day 2: what she needed and did not receive. Day 3's statement uses it. */
  unmetNeed: string | null
}

/**
 * The registry holds definitions of differing shapes, so it is typed loosely
 * on purpose. Each definition is still strictly typed at its own definition
 * site, which is where mistakes actually happen.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export type AnyBlockDefinition = BlockDefinition<z.ZodType<any>, any>
