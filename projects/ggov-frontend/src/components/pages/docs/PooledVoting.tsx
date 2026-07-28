import { ArrowRight } from 'lucide-react'
import { ArticleHeader, Callout, H2, InlineLink, Lead, P, Pager, Strong } from '@/components/pages/docs/components'

/**
 * The AlgoQuarters definition, as a small inline formula strip. Local to this
 * page — it's the one piece of prose furniture the docs primitives don't cover.
 */
function AqFormula() {
  return (
    <div className="my-6 flex flex-wrap items-center gap-3 rounded-md border border-border bg-muted/40 px-4 py-3">
      <code className="font-mono text-[13.5px] text-foreground">1 ALGO × 3M blocks</code>
      <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <code className="font-mono text-[13.5px] font-semibold text-teal-strong">1 AlgoQuarter (AQ)</code>
    </div>
  )
}

export default function PooledVoting() {
  return (
    <div>
      <ArticleHeader to="/docs/pooled-voting" />
      <div className="mt-[22px]">
        <Lead>
          Liquid staking tokens (xALGO, tALGO) and Reti pools produce blocks from shared accounts — so the voting power
          lands with the pool, not with you. Pooled voting gives it back: you vote your prorated share, and the pool
          casts the combined result on-chain.
        </Lead>

        <AqFormula />

        <H2>Your share of the pool</H2>
        <P>
          Your pool measures each member's contribution in <Strong>AlgoQuarters</Strong> — stake over time across the
          committee window. Your AQ share of the pool's total is exactly your share of its voting power. The pool
          reports contributions for each committee; there's nothing for you to register or opt into.
        </P>

        <H2>How your vote travels</H2>
        <P>
          Pooled positions appear next to your own accounts on any open period, and you vote the same way any direct
          voter does — scoring each option <Strong>Support</Strong> (+1), <Strong>Veto</Strong> (−1) or{' '}
          <Strong>Abstain</Strong> (0). Your choices are weighted by your AQ and tallied with every other member's vote;
          the pool then maps the combined tally onto its full voting power and casts the external vote on-chain via{' '}
          <InlineLink to="/docs/delegation">delegation</InlineLink> from its escrow accounts.
        </P>

        <H2>If you don't vote</H2>
        <P>
          Your share scores <Strong>Abstain</Strong> on every option — the pool never invents a preference for you. And
          like any vote, you can change yours until the period closes.
        </P>
        <Callout variant="info">
          Pooled figures are approximate until the period closes: your effective weight is your AQ share of the pool's
          snapshotted power for that committee.
        </Callout>
      </div>
      <Pager from="/docs/pooled-voting" />
    </div>
  )
}
