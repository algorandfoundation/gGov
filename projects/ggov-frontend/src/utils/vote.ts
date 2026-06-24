/** Sentiment a free-form option label maps to (`other` = candidate names / unrecognized). */
export type OptionSentiment = 'yes' | 'no' | 'abstain' | 'other'

// Free-form on-chain option labels, classified by leading keyword. Single source of
// truth so the election net-score tally and the per-account record swatches never
// disagree on what a label means.
const YES_RE = /^(for\b|approve|approved|yes\b|in favou?r|favou?r|support|pass)/
const NO_RE = /^(against|no\b|reject|oppose|fail|veto)/
const ABSTAIN_RE = /^(abstain|neutral|none|no vote)/

/** Classify an option label into a Yes/No/Abstain sentiment, or `other`. */
export function classifyOption(label: string): OptionSentiment {
  const l = label.trim().toLowerCase()
  if (YES_RE.test(l)) return 'yes'
  // Abstain before No: NO_RE's `no\b` matches "no vote", so abstain phrases that
  // start with "no " must be claimed here first or they'd be miscounted as No.
  if (ABSTAIN_RE.test(l)) return 'abstain'
  if (NO_RE.test(l)) return 'no'
  return 'other'
}

/**
 * Reduce a candidate-topic's options/tallies to Yes/No/Abstain totals. Options are
 * free-form, so classify by label ({@link classifyOption}); if no option label is
 * recognized, fall back to positional order [Yes, No, Abstain].
 */
export function tallyBallot(options: string[], tallies: number[]): { yes: number; no: number; abstain: number } {
  let yes = 0
  let no = 0
  let abstain = 0
  let matched = false
  options.forEach((opt, i) => {
    const t = tallies[i] ?? 0
    switch (classifyOption(opt)) {
      case 'yes':
        yes += t
        matched = true
        break
      case 'no':
        no += t
        matched = true
        break
      case 'abstain':
        abstain += t
        matched = true
        break
    }
  })
  if (!matched) {
    yes = tallies[0] ?? 0
    no = tallies[1] ?? 0
    abstain = tallies[2] ?? 0
  }
  return { yes, no, abstain }
}

/**
 * Index of the single option a vote-record's topic entry put power on, or
 * `undefined` when the topic wasn't voted or the power was split across more than
 * one option — in which case there is no single "your vote" option to highlight.
 */
export function singleChoiceIndex(topicVotes: number[] | undefined): number | undefined {
  if (!topicVotes) return undefined
  let found: number | undefined
  for (let i = 0; i < topicVotes.length; i++) {
    if (topicVotes[i] > 0) {
      if (found !== undefined) return undefined // more than one non-zero → split vote
      found = i
    }
  }
  return found
}
