/**
 * Certificate requirements.
 *
 * A certificate that anyone can get by clicking through is worth nothing, and
 * one that nobody can get is worse. These are pure functions over her actual
 * progress so the rules can be tested and so the same evaluation runs whether
 * a certificate is issued automatically or checked by hand.
 */

export type RequirementType =
  | 'lessons_completed_pct'
  | 'required_blocks_answered'
  | 'post_assessment_submitted'
  | 'her_choices_logged'
  | 'her_code_finalized'

export interface Requirement {
  requirementType: RequirementType
  /** Percent for the pct rule, a count for the others, ignored for booleans. */
  threshold: number
}

/** What she has actually done. */
export interface Progress {
  lessonsTotal: number
  lessonsCompleted: number
  requiredBlocksTotal: number
  requiredBlocksAnswered: number
  postAssessmentSubmitted: boolean
  herChoicesLogged: number
  herCodeFinalized: boolean
}

export interface RequirementCheck {
  requirementType: RequirementType
  met: boolean
  /** Human-readable, for the admin view and for telling her what is left. */
  detail: string
}

export function evaluateRequirement(
  requirement: Requirement,
  progress: Progress,
): RequirementCheck {
  const { requirementType: type, threshold } = requirement

  switch (type) {
    case 'lessons_completed_pct': {
      // No lessons at all cannot count as "100% complete" - that would hand a
      // certificate to somebody who has done nothing.
      if (progress.lessonsTotal === 0) {
        return {
          requirementType: type,
          met: false,
          detail: 'This programme has no lessons yet.',
        }
      }
      const pct = Math.round(
        (progress.lessonsCompleted / progress.lessonsTotal) * 100,
      )
      return {
        requirementType: type,
        met: pct >= threshold,
        detail: `${pct}% of days finished (needs ${threshold}%)`,
      }
    }

    case 'required_blocks_answered': {
      // A programme with no required blocks trivially satisfies this.
      const met =
        progress.requiredBlocksTotal === 0 ||
        progress.requiredBlocksAnswered >= progress.requiredBlocksTotal
      return {
        requirementType: type,
        met,
        detail: `${progress.requiredBlocksAnswered} of ${progress.requiredBlocksTotal} required exercises done`,
      }
    }

    case 'post_assessment_submitted':
      return {
        requirementType: type,
        met: progress.postAssessmentSubmitted,
        detail: progress.postAssessmentSubmitted
          ? 'Closing assessment submitted'
          : 'Closing assessment not submitted',
      }

    case 'her_choices_logged':
      return {
        requirementType: type,
        met: progress.herChoicesLogged >= threshold,
        detail: `${progress.herChoicesLogged} logged (needs ${threshold})`,
      }

    case 'her_code_finalized':
      return {
        requirementType: type,
        met: progress.herCodeFinalized,
        detail: progress.herCodeFinalized
          ? 'HER Code written'
          : 'HER Code not written yet',
      }
  }
}

export interface Eligibility {
  eligible: boolean
  checks: RequirementCheck[]
  outstanding: RequirementCheck[]
}

export function evaluateEligibility(
  requirements: Requirement[],
  progress: Progress,
): Eligibility {
  // A programme with no requirements configured does NOT award a certificate.
  // Silence must not mean yes.
  if (requirements.length === 0) {
    return { eligible: false, checks: [], outstanding: [] }
  }

  const checks = requirements.map((r) => evaluateRequirement(r, progress))
  const outstanding = checks.filter((c) => !c.met)

  return { eligible: outstanding.length === 0, checks, outstanding }
}

/**
 * A human-readable certificate number: DFA-2026-000123.
 *
 * Sequence comes from the count of certificates already issued, so numbers are
 * stable, sortable and obviously not a database id.
 */
export function certificateNumber(sequence: number, year: number): string {
  return `DFA-${year}-${String(sequence).padStart(6, '0')}`
}
