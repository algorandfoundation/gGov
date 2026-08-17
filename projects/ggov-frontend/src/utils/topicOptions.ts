/**
 * Topic options rules, mirrored from `GGovPeriodContract.ensureValidOptions`: an option list must be
 * non-empty, end in the literal `Abstain`, and carry it exactly once, else the call fails `GT_OA` (or
 * `GT_NO` for an empty list). The manage panel therefore edits only the custom options and appends
 * Abstain via `withAbstain`, which keeps the editors' row indices clear of off-by-one guards.
 */

/** The Abstain label. Must match the contract literal. */
export const ABSTAIN_OPTION = 'Abstain'

/** Minimum non-Abstain options typed by operator. Frontend-only — the contract accepts a single ['Abstain'] entry. */
export const MIN_CUSTOM_OPTIONS = 2

/** Assemble the on-chain option list from the operator's custom options. */
export function withAbstain(custom: string[]): string[] {
  return [...custom, ABSTAIN_OPTION]
}

function isAbstain(value: string): boolean {
  return value.trim().toLowerCase() === ABSTAIN_OPTION.toLowerCase()
}

export interface OptionIssues {
  /** Every option trimmed, positionally parallel to the input. */
  trimmed: string[]
  blankIdx: Set<number>
  duplicateIdx: Set<number>
  abstainIdx: Set<number>
}

/** The trimmed options, plus the per-row problems found in them. Callers decide which block a save. */
export function findOptionIssues(options: string[]): OptionIssues {
  const trimmed = options.map((o) => o.trim())

  // Duplicates match exactly, so `Yes` and `yes` are distinct options. `isAbstain` is
  // deliberately looser — Abstain is caught in any casing.
  const seen = new Set<string>()
  const repeated = new Set<string>()
  trimmed.forEach((t) => {
    if (t === '') return
    if (seen.has(t)) repeated.add(t)
    else seen.add(t)
  })

  const blankIdx = new Set<number>()
  const duplicateIdx = new Set<number>()
  const abstainIdx = new Set<number>()
  trimmed.forEach((t, i) => {
    if (t === '') blankIdx.add(i)
    else if (repeated.has(t)) duplicateIdx.add(i)
    if (isAbstain(t)) abstainIdx.add(i)
  })

  return { trimmed, blankIdx, duplicateIdx, abstainIdx }
}
