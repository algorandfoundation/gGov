import { ArticleHeader, Callout, H2, Lead, P, Pager, Strong } from '@/components/pages/docs/components'

export default function Periods() {
  return (
    <div>
      <ArticleHeader to="/docs/periods" />
      <div className="mt-[22px]">
        <Lead>Governance happens in periods. Each period has one or more topics for you to vote on.</Lead>

        <H2>Periods have a start and end</H2>
        <P>
          A period is <Strong>upcoming</Strong> before it opens, <Strong>active</Strong> while voting is open, and{' '}
          <Strong>ended</Strong> once it closes. You can read an upcoming period's topics early, but voting only happens
          while it's active.
        </P>

        <H2>Topics are what you decide</H2>
        <P>
          A topic is a single decision — it might be a seat to fill or a yes/no question. A period can bundle several
          topics together, and you vote on each one.
        </P>

        <H2>Votes are weighted by your power</H2>
        <P>
          When you vote, your choice carries the weight of your voting power for that period's committee. More blocks
          produced means more weight behind your vote.
        </P>

        <H2>You can change your mind</H2>
        <P>
          While a period is active you can update or change your vote as many times as you like. When the period closes,
          the final tally is recorded on-chain for anyone to verify.
        </P>
        <Callout variant="info">
          Nothing is final until the period closes — your last vote is the one that counts.
        </Callout>
      </div>
      <Pager from="/docs/periods" />
    </div>
  )
}
