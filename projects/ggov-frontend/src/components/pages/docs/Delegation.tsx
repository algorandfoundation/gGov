import { ArticleHeader, Callout, H2, InlineLink, Lead, P, Pager, Strong } from '@/components/pages/docs/components'

export default function Delegation() {
  return (
    <div>
      <ArticleHeader to="/docs/delegation" />
      <div className="mt-[22px]">
        <Lead>
          Don't want to vote yourself? Hand your voting power to an account you trust. Want to do the voting? You can
          act for accounts that delegated to you.
        </Lead>

        <H2>What delegation does</H2>
        <P>
          Delegation lets one account vote with another account's power. The power still belongs to you — you're just
          letting someone else cast it on your behalf. You're never locked in: you can step in and vote yourself at any
          time, and your own vote always overrides your delegate's.
        </P>

        <H2>Delegating your power</H2>
        <P>
          Point your account at the account you want to vote for you. It takes effect immediately, and it doesn't change
          any votes that have already been cast. You can change or remove it whenever you like.
        </P>

        <H2>Receiving delegations</H2>
        <P>
          If others delegate to you, their voting power is added to yours, and you can vote on their behalf. The app
          shows you exactly which accounts you can act for.
        </P>

        <H2>The direct-vote rule</H2>
        <P>
          If an account votes for itself directly, its delegate is shut out for the rest of the period. Direct voting
          always wins over delegation.
        </P>
        <Callout variant="warning">
          <Strong>A delegate can't override a direct vote.</Strong> If an account you act for has voted on its own, you
          can no longer vote on its behalf for the rest of that period.
        </Callout>

        <H2>Pooled power is included</H2>
        <P>
          If you stake through xALGO, tALGO or a Réti pool, the same delegation covers your{' '}
          <InlineLink to="/docs/pooled-voting">pooled share</InlineLink> — there's no separate setting, even if all your
          power is pooled. Your delegate votes it alongside any power you hold directly, and if they don't vote it
          counts as <Strong>Abstain</Strong>: the same as any unvoted share.
        </P>
      </div>
      <Pager from="/docs/delegation" />
    </div>
  )
}
