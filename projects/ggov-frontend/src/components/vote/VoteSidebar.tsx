import { useWallet } from '@txnlab/use-wallet-react'
import { Card } from '@/components/ui/card'
import { Stat } from '@/components/ui/stat'
import { Tag } from '@/components/ui/tag'
import { AccountAvatar } from '@/components/AccountAvatar'
import { Eyebrow } from '@/components/ui/eyebrow'
import { BlockGrid } from '@/components/ui/block-grid'
import ConnectWallet from '@/components/ConnectWallet'
import CompactAccountSwitcher from '@/components/CompactAccountSwitcher'
import { useAddressName } from '@/hooks/use-nfd'
import { useCommittee, useGlobalState, useProducerRank, useXGovVotingPowers } from '@/hooks/queries'
import { ellipseAddress } from '@/utils/ellipseAddress'
import { formatBlockRange } from '@/utils/format'
import { MOCK_AVERAGE_PARTICIPATION_PCT } from '@/lib/mockMetrics'

/** Connected-account identity card. Renders nothing when logged out. */
export function AccountCard() {
  const { activeAddress } = useWallet()
  const { data: nfd } = useAddressName(activeAddress)
  if (!activeAddress) return null
  const label = nfd ?? ellipseAddress(activeAddress)

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <AccountAvatar address={activeAddress} name={label} size={40} />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{label}</div>
            <div className="font-mono text-xs text-muted-foreground">{ellipseAddress(activeAddress, 4)}</div>
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 text-xs text-success-foreground">
          <span className="size-[7px] rounded-full bg-success" />
          Connected
        </span>
      </div>
      {/* Switch the active (signing) account when the wallet exposes several. */}
      <CompactAccountSwitcher className="mt-4 border-t border-border pt-3" />
    </Card>
  )
}

/** "Your voting power" — votes (= blocks produced) for the active period's committee. */
export function VotingPowerCard({ committeeId }: { committeeId?: string }) {
  const { activeAddress } = useWallet()
  const { data: committee } = useCommittee(committeeId)
  const powers = useXGovVotingPowers(committeeId, activeAddress ? [activeAddress] : [])
  const power = activeAddress ? powers[activeAddress] : undefined
  const { data: rank } = useProducerRank(committeeId, activeAddress)

  const blockRange = committee ? formatBlockRange(committee.periodStart, committee.periodEnd) : null
  const windowLabel = blockRange ? `window ${blockRange}` : null

  if (!activeAddress) {
    return (
      <Card className="flex flex-col gap-3.5 p-5">
        <Eyebrow>Your voting power</Eyebrow>
        <div className="font-display text-[40px] font-bold leading-none text-muted-foreground">——</div>
        <p className="text-[13px] leading-snug text-muted-foreground">
          Your weight is the number of blocks you produced in the current window
          {blockRange ? ` (${blockRange})` : ''}. Connect a wallet to see it.
        </p>
        <ConnectWallet />
      </Card>
    )
  }

  // Share of the committee's total votes, mapped onto the 48-cell grid (≥1 cell when
  // the account produced any blocks). A rough magnitude viz, not an exact ratio.
  const total = committee?.totalVotes ?? 0
  const value = Number(power ?? 0)
  const filled = total > 0 ? Math.max(value > 0 ? 1 : 0, Math.round((value / total) * 48)) : 0

  return (
    <Card className="p-5">
      <Stat
        eyebrow="Your voting power"
        value={value.toLocaleString()}
        caption="Votes — one for every block you produced in the current window."
        solidColor="var(--algo-blue)"
        size={40}
      />
      <div className="my-4">
        <BlockGrid filled={filled} />
      </div>
      <div className="flex items-center justify-between gap-2">
        {rank && <Tag tone="teal">Top {rank.topPercentile}% of producers</Tag>}
        {windowLabel && <span className="text-xs text-muted-foreground">{windowLabel}</span>}
      </div>
    </Card>
  )
}

const STEPS = [
  { title: 'One block, one vote', body: 'Your weight equals the blocks you produced.' },
  { title: '3M-block window', body: 'Each window spans 3M blocks and advances 1M at a time (e.g. 59M–62M).' },
  { title: 'No opt-in required', body: "Governance isn't incentivized — no ALGO committed and no opt-in needed." },
]

export function HowGovernanceWorksCard() {
  return (
    <Card className="flex flex-col gap-3.5 p-5">
      {STEPS.map((step, i) => (
        <div key={step.title} className="flex gap-3">
          <div className="flex size-[30px] flex-none items-center justify-center rounded-lg bg-primary/10 font-display text-sm font-bold text-primary dark:bg-algo-teal/15 dark:text-algo-teal">
            {i + 1}
          </div>
          <div>
            <div className="text-sm font-semibold">{step.title}</div>
            <div className="text-[13px] leading-snug text-muted-foreground">{step.body}</div>
          </div>
        </div>
      ))}
    </Card>
  )
}

/** Aggregate governance stats. */
export function PeriodStatsCard({ committeeId }: { committeeId?: string }) {
  const { data: committee } = useCommittee(committeeId)
  const { data: globalState } = useGlobalState()
  const periodsToDate = globalState?.lastPeriodId != null ? Number(globalState.lastPeriodId) : undefined

  const rows: { caption: string; value: string }[] = [
    { caption: 'Eligible voters this window', value: committee ? committee.totalMembers.toLocaleString() : '—' },
    { caption: 'Voting periods to date', value: periodsToDate != null ? String(periodsToDate) : '—' },
    // TODO(FLAG): average participation is mocked — see lib/mockMetrics.ts
    { caption: 'Average participation', value: `${MOCK_AVERAGE_PARTICIPATION_PCT}%` },
  ]

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5">
      {rows.map((row) => (
        <div key={row.caption} className="flex items-baseline justify-between gap-2">
          <span className="text-[13px] text-muted-foreground">{row.caption}</span>
          <span className="font-display text-[19px] font-bold tabular-nums">{row.value}</span>
        </div>
      ))}
    </div>
  )
}

export function LegacyPortalCard() {
  return (
    <div className="rounded-xl border border-border bg-muted/40 p-5">
      <div className="font-display text-[15px] font-bold">Periods 1–15</div>
      <p className="mt-1.5 text-[13px] leading-snug text-muted-foreground">
        Governance from 2021–2025, including the ALGO-commitment rounds, lives on the legacy portal.
      </p>
      <a
        href="https://governance.algorand.foundation/"
        target="_blank"
        rel="noopener noreferrer"
        className="mt-3 inline-flex items-center gap-1.5 text-[13.5px] font-semibold text-primary dark:text-algo-teal"
      >
        Open legacy portal →
      </a>
    </div>
  )
}
