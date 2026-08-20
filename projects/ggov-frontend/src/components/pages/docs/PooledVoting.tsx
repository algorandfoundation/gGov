import { ArrowRight } from 'lucide-react'
import { ArticleHeader, H2, InlineLink, Lead, P, Pager, Strong } from '@/components/pages/docs/components'

/**
 * A small inline formula strip ("left → right"). Local to this page — it's the one
 * piece of prose furniture the docs primitives don't cover.
 */
function Formula({ from, to }: { from: string; to: string }) {
  return (
    <div className="my-6 flex flex-wrap items-center gap-3 rounded-md border border-border bg-muted/40 px-4 py-3">
      <code className="font-mono text-[13.5px] text-foreground">{from}</code>
      <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <code className="font-mono text-[13.5px] font-semibold text-teal-strong">{to}</code>
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
          lands with the pool, not with you. Pooled voting gives it back: you vote your share, and it's carried into the
          pool's vote on-chain.
        </Lead>

        <H2>Your prorated share of the pool</H2>
        <P>
          Your contributions to pools are measured in <Strong>AlgoQuarters</Strong> — stake over time across the
          committee window. Contributions are reported for each committee; there's nothing for you to register or opt
          into.
        </P>

        <Formula from="1 ALGO × 3M blocks" to="1 AlgoQuarter (AQ)" />

        <H2>How your share becomes votes</H2>
        <P>
          Your governance voting power is proportional to your AQ share of the pool's total AQ. Your approximate voting
          power is:
        </P>

        <Formula from="Your AQ ÷ Total pool AQ × Pool voting power" to="Your votes" />

        <H2>How your vote travels</H2>
        <P>
          Pooled positions appear next to your own accounts on any open period, and you vote the same way any direct
          voter does. Your choices are weighted by your AQ and tallied with every other pool member's vote; the combined
          tally is mapped onto the pool's full voting power and cast on-chain. Your own ballot is recorded on-chain too
          — in the pool's internal records, weighted in AQ.
        </P>

        <H2>If you don't vote</H2>
        <P>
          Your share votes <Strong>Abstain</Strong> on every option. The pool can't vote it for you — only you, or an
          account you delegate to, can. And like any vote, you can change yours until the period closes.
        </P>

        <H2>Delegation applies</H2>
        <P>
          <InlineLink to="/docs/delegation">Delegating</InlineLink> your governance power applies to pooled voting as
          well. Your delegate can vote your share of the pool, and you can revoke delegation at any time. If they don't
          vote, your share counts as <Strong>Abstain</Strong>, just as if you hadn't voted yourself.
        </P>

        <H2>Why the pool's full weight appears at once</H2>
        <P>
          A period records each account's <Strong>full</Strong> voting power on every topic, so the first vote from
          anyone in the pool — however small their share — puts the pool's whole weight on-chain, with every share that
          hasn't voted yet counted as <Strong>Abstain</Strong>. Nothing has been decided for you: as members vote, their
          shares move off Abstain onto their own choices. Only the split changes, never the total.
        </P>

        <H2>Fractional votes matter</H2>
        <P>
          Fractional votes are rounded down on the Governance platform, but within each pool they are kept and can add
          up to whole votes. If the first pooled voter casts the equivalent of 0.5 votes, the pool casts all abstain —
          not enough for a full vote. But when a second voter puts another 0.5 votes behind the same option, the pool
          casts 1 vote, carried by the cumulative support of the two fractional-power voters.
        </P>

        <H2>Whole AQ, and the 1 AQ minimum</H2>
        <P>
          AQ itself is always a whole number. Your contribution accrues exactly — the balance you held multiplied by the
          rounds you held it, down to the microALGO — and is rounded down only once, at the end of the committee window.
          Nothing is lost as your balance moves during the window; only the final remainder is dropped.
        </P>
        <P>
          The unit is also the cutoff: an account whose window rounds down to less than <Strong>1 AQ</Strong> isn't
          reported at all — no dust entries, and no share to vote. Since a committee window is roughly 3M blocks, that
          floor is about <Strong>1 ALGO held in the pool for the whole window</Strong> — or proportionally more ALGO
          held for a shorter slice of it.
        </P>

        <H2>How tALGO and stALGO count</H2>
        <P>
          Both of Tinyman's tokens count, and they count the same. Your balances are added together — one{' '}
          <Strong>stALGO</Strong> is one <Strong>tALGO</Strong>, so re-staking for TINY rewards never costs you a share
          — and then converted into the ALGO they represent, at the tALGO rate for that window.
        </P>

        <Formula from="(tALGO + stALGO) × tALGO rate" to="Your position in ALGO" />

        <P>
          That ALGO figure is what earns AlgoQuarters, block by block, for as long as you hold it: tokens bought halfway
          through a window earn half a window's worth, and tokens you sell stop earning the moment they leave your
          account. Your AQ then buys your share of the pool's votes, exactly as above.
        </P>
        <P>
          Only tokens in your own account earn. tALGO supplied to a liquidity pool is held by that pool for as long as
          it sits there, so it earns AlgoQuarters for the pool's account, not for you.
        </P>

        <H2>How Réti stake counts</H2>
        <P>
          A <Strong>Réti</Strong> pool holds plain ALGO, so there is no token and no conversion: the ALGO you have
          staked in the pool is what earns, from the block it is added until the block it is removed. Rewards are paid
          into your stake at the end of each epoch, and the larger stake earns from there on — leave a position alone
          and it earns a little faster as the window goes by. Join partway through an epoch and that first payout is
          reduced to match your time in the pool.
        </P>

        <Formula from="Your stake + past epoch rewards" to="Your position in ALGO" />

        <P>
          Each validator is counted on its own. A validator can run several pools, and anything you have staked across
          them is added together first, so spreading a position over one validator's own pools costs you nothing. What
          stays separate is the validator: a stake with a second validator earns its own share there, so you vote once
          for each validator you stake with.
        </P>
      </div>
      <Pager from="/docs/pooled-voting" />
    </div>
  )
}
