import { Clock } from 'lucide-react'
import { ArticleHeader, Callout, H2, InlineLink, Lead, P, Pager, Strong } from '@/components/pages/docs/components'

export default function Committees() {
  return (
    <div>
      <ArticleHeader to="/docs/committees" />
      <div className="mt-[22px]">
        <Lead>
          A committee is the group of accounts allowed to vote in a given window — with each member's weight set by the
          blocks they produced.
        </Lead>

        <H2>What a committee is</H2>
        <P>
          Think of a committee as the guest list for a vote. It records who was eligible and how much voting power each
          account had, all based on block production over a set stretch of time.
        </P>

        <H2>The window of rounds</H2>
        <P>
          Algorand counts time in <Strong>rounds</Strong> — one round per block. A committee covers a fixed range of
          rounds (its window). Every block produced in that window counts toward a member's voting power.
        </P>

        <H2>How membership is decided</H2>
        <P>
          There's no application and no sign-up. If your account produced blocks during the window, you're in the
          committee, with power equal to the number of blocks you produced.
        </P>

        <H2>Committees and periods</H2>
        <P>
          Each voting period uses one committee to decide who can vote and how much weight they carry.{' '}
          <InlineLink to="/docs/periods">See how periods work →</InlineLink>
        </P>
        <Callout variant="neutral" icon={<Clock className="size-[18px]" />}>
          A committee is a snapshot of history. Once its window has passed, its members and their voting power never
          change.
        </Callout>
      </div>
      <Pager from="/docs/committees" />
    </div>
  )
}
