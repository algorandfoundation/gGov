import { ArticleHeader, Callout, H2, InlineLink, Lead, P, Pager, Strong } from '@/components/pages/docs/components'

export default function GettingStarted() {
  return (
    <div>
      <ArticleHeader to="/docs/getting-started" />
      <div className="mt-[22px]">
        <Lead>Taking part in Algorand governance takes a few minutes. Here's the whole path, start to finish.</Lead>

        <H2>1. Connect your wallet</H2>
        <P>
          Open the governance app and connect the wallet you use on Algorand. You can connect more than one account —
          you'll be able to act for any of them.
        </P>

        <H2>2. Check your voting power</H2>
        <P>
          Your voting power is based on the blocks your account produced. The app shows how much power each of your
          accounts has for the current period. <InlineLink to="/docs/voting-power">How voting power works →</InlineLink>
        </P>

        <H2>3. Find an open period</H2>
        <P>
          Governance happens in <Strong>periods</Strong>. Each open period lists its <Strong>topics</Strong> — the
          things being decided — or, if it's an election, the <Strong>candidates</Strong> running. Open one to read the
          details.
        </P>

        <H2>4. Cast your vote</H2>
        <P>Choose your options and submit. Your vote is recorded on-chain and weighted by your voting power.</P>
        <Callout variant="info">You can change your vote any time before the period closes.</Callout>

        <H2>5. Or delegate, if you'd rather not vote</H2>
        <P>
          Prefer to let someone vote on your behalf? You can hand your voting power to an account you trust.{' '}
          <InlineLink to="/docs/delegation">Read the delegation rules →</InlineLink>
        </P>
      </div>
      <Pager from="/docs/getting-started" />
    </div>
  )
}
