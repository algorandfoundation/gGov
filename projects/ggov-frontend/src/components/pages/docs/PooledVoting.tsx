import { ArrowRight } from 'lucide-react'
import { ArticleHeader, H2, InlineLink, Lead, P, Pager, Strong } from '@/components/pages/docs/components'

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
          Liquid staking tokens (xALGO, tALGO) and Réti pools produce blocks from shared accounts — so the voting power
          lands with the pool, not with you. Pooled voting gives it back: you vote your prorated share, and the combined
          result is cast on-chain.
        </Lead>

        <H2>Your share of the pool</H2>
        <P>
          Your contributions to pools are measured in <Strong>AlgoQuarters</Strong> — stake over time across the
          committee window. Your AQ share of the pool's total AQ is exactly your share of the pool's voting power.
          Contributions are reported for each committee; there's nothing for you to register or opt into.
        </P>

        <AqFormula />

        <H2>How your vote travels</H2>
        <P>
          Pooled positions appear next to your own accounts on any open period, and you vote the same way any direct
          voter does. Your choices are weighted by your AQ and tallied with every other pool member's vote; the combined
          tally is mapped onto the pool's full voting power and the resulting vote is cast on-chain.
        </P>

        <H2>If you don't vote</H2>
        <P>
          Your share votes <Strong>Abstain</Strong> on every option — no preference is ever invented on your behalf. And
          like any vote, you can change yours until the period closes.
        </P>

        <H2>Why the pool's full weight appears at once</H2>
        <P>
          A period records each account's <Strong>full</Strong> voting power on every topic, so the first vote from
          anyone in the pool — however small their share — puts the pool's whole weight on-chain, with every share that
          hasn't voted yet counted as <Strong>Abstain</Strong>. Nothing has been decided for you: as members vote, their
          shares move off Abstain onto their own choices. Only the split changes, never the total.
        </P>

        <H2>Delegation applies</H2>
        <P>
          <InlineLink to="/docs/delegation">Delegating</InlineLink> your governance power applies to pooled voting as
          well. The delegated party will be able to vote with your share of the pool, and you can revoke delegation at
          any time. If you delegate to a party that doesn't vote, your share will score <Strong>Abstain</Strong> just
          like if you didn't vote yourself.
        </P>
      </div>
      <Pager from="/docs/pooled-voting" />
    </div>
  )
}
