import { ArticleHeader, Callout, H2, Lead, P, Pager, Strong } from '@/components/pages/docs/components'

export default function Periods() {
  return (
    <div>
      <ArticleHeader to="/docs/periods" />
      <div className="mt-[22px]">
        <Lead>
          Governance happens in periods. Each period has one or more topics for you to vote on — or, if it's an
          election, candidates to rank.
        </Lead>

        <H2>Periods have a start and end</H2>
        <P>
          A period is <Strong>upcoming</Strong> before it opens, <Strong>active</Strong> while voting is open, and{' '}
          <Strong>ended</Strong> once it closes. You can read an upcoming period's topics early, but voting only happens
          while it's active.
        </P>

        <H2>Topics are what you decide</H2>
        <P>
          A topic is a single decision — usually a yes/no question. A period can bundle several topics together, and you
          vote on each one.
        </P>

        <H2>Some periods are elections</H2>
        <P>
          An election period fills <Strong>seats</Strong> rather than answering questions. Its ballot lists{' '}
          <Strong>candidates</Strong> instead of topics, and you vote <Strong>Support</Strong>, <Strong>Veto</Strong> or{' '}
          <Strong>Abstain</Strong> on each one. Candidates are ranked by net score: Support minus Veto, with Abstain
          counting for nothing. The highest-scoring candidates lead for the seats on offer.
        </P>
        <P>
          One period can run <Strong>several elections at once</Strong>: a council and a committee, say, sharing a
          single ballot and a single voting window. Each candidate stands in exactly one of them, and each election is
          ranked separately against its own seat count — so a candidate only ever competes with the others in their
          race.
        </P>
        <Callout variant="info">
          You cast a vote on every candidate on the ballot, including races you don't have a view on. To sit one out,
          pick <Strong>Abstain</Strong> — it leaves every candidate's score untouched.
        </Callout>

        <H2>Candidates are listed in a random order</H2>
        <P>
          Being first on a ballot is an advantage nobody earned, so within each election{' '}
          <Strong>every browser gets its own order</Strong> of the candidates. Spread across all the voters, no
          candidate sits at the top for everyone.
        </P>
        <P>
          Your order is <Strong>fixed</Strong>, not reshuffled on each visit: refresh the page, close the tab, or come
          back tomorrow to change your vote, and the candidates are exactly where you left them. It's drawn from a
          random value your browser saves the first time you open an election, so a different browser, a different
          device, or clearing this site's data gives you a different order.
        </P>
        <Callout variant="info">
          Order is presentation only. Every candidate is ranked by the same net score, and where they appeared on your
          ballot has no effect on the result.
        </Callout>

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
