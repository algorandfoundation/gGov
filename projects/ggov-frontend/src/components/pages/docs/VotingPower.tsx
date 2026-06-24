import { ArrowRight } from 'lucide-react'
import { ArticleHeader, H2, InlineLink, Lead, P, Pager, Strong } from '@/components/pages/docs/components'

export default function VotingPower() {
  return (
    <div>
      <ArticleHeader to="/docs/voting-power" />
      <div className="mt-[22px]">
        <Lead>Your voting power is simply the number of blocks your account produced. One block, one vote.</Lead>

        {/* 1 block → 1 vote feature row */}
        <div className="my-6 mb-[26px] flex items-center gap-4 rounded-lg border border-border bg-card px-6 py-[22px]">
          <span className="whitespace-nowrap font-display text-[30px] font-bold text-primary">1 block</span>
          <ArrowRight className="size-[22px] text-muted-foreground" />
          <span className="whitespace-nowrap font-display text-[30px] font-bold text-foreground">1 vote</span>
        </div>

        <H2>What counts as voting power</H2>
        <P>
          Every account on Algorand can help produce blocks. The more blocks your account produced during a period's
          window, the more voting power you have for that period. Power is a simple, whole count of blocks — shown in
          the app as a number of votes.
        </P>

        <H2>No staking, no lock-up</H2>
        <P>
          You don't lock up any ALGO to gain voting power, and there's nothing to sign up for in advance. Your power
          comes purely from taking part in securing the network by producing blocks.
        </P>

        <H2>It's measured fresh each period</H2>
        <P>
          Each period looks at the blocks produced over its own range of rounds, so your voting power can be different
          from one period to the next. If you produced more blocks this time, you'll have more votes this time.
        </P>

        <H2>Where your power is grouped</H2>
        <P>
          The set of accounts eligible for a period — and each one's power — is called a <Strong>committee</Strong>.{' '}
          <InlineLink to="/docs/committees">Learn about committees →</InlineLink>
        </P>
      </div>
      <Pager from="/docs/voting-power" />
    </div>
  )
}
