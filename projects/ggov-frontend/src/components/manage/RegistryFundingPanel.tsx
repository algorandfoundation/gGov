import { useState } from 'react'
import { useWallet } from '@txnlab/use-wallet-react'
import { ChevronDown } from 'lucide-react'
import { Callout } from '@/components/ui/callout'
import { Eyebrow } from '@/components/ui/eyebrow'
import { Skeleton } from '@/components/ui/skeleton'
import { Slider } from '@/components/ui/slider'
import { Stat } from '@/components/ui/stat'
import { Surface } from '@/components/ui/surface'
import { TxButton } from '@/components/TxButtonContent'
import AppExplorerLink from '@/components/AppExplorerLink'
import { useMbrEstimates, type RegistryMbr } from '@/hooks/mbrQueries'
import { useTopUpRegistryMutation } from '@/hooks/mutations'
import type { FracMbrEstimate, GgovMbrEstimate } from '@/lib/mbrEstimate'
import { formatAlgo } from '@/utils/format'
import { cn } from '@/lib/utils'

/**
 * Worst-case MBR each registry must be able to supply, against what it holds.
 *
 * Both registries fund their children rather than themselves — a vote's box MBR is paid by the
 * period or instance app and refilled from the registry in fixed `mbrTopUp` chunks, and a delegation
 * is paid by the gGov registry outright. Neither carries a payment from the caller, so an
 * underfunded registry does not fail loudly: it simply starts rejecting votes and delegations. This
 * panel is the early warning.
 *
 * See `lib/mbrEstimate.ts` for the arithmetic and what is deliberately excluded from it.
 */

/** µAlgo figure with its unit, at the label/value scale used by the breakdown rows. */
function Algo({ value }: { value: bigint }) {
  return (
    <span className="tabular-nums">
      {formatAlgo(value)} <span className="text-xs text-muted-foreground">ALGO</span>
    </span>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  )
}

interface RegistryColumnProps {
  title: string
  registry: RegistryMbr
  /** Rendered inside the collapsible breakdown. */
  breakdown: React.ReactNode
  /** Passed to the top-up toast so it names the right registry. */
  label: string
  loading: boolean
  /**
   * The only column on this network (no frac registry). Caps the width so the label/value rows and
   * the top-up button don't stretch the full page — a lone column otherwise reads as a stray row
   * rather than half of a pair.
   */
  solo?: boolean
}

function RegistryColumn({ title, registry, breakdown, label, loading, solo }: RegistryColumnProps) {
  const [open, setOpen] = useState(false)
  const { activeAddress } = useWallet()
  const topUp = useTopUpRegistryMutation()

  const short = registry.shortfall > 0n

  return (
    <div className={cn('flex min-w-0 flex-1 flex-col gap-3', solo && 'md:max-w-md')}>
      <div className="flex items-baseline justify-between gap-3">
        <Eyebrow>{title}</Eyebrow>
        <AppExplorerLink appId={registry.appId} />
      </div>

      {loading ? (
        <Skeleton className="h-10 w-40" />
      ) : (
        <Stat
          eyebrow="Required"
          size={32}
          value={
            <>
              {formatAlgo(registry.required)} <span className="text-base font-normal text-muted-foreground">ALGO</span>
            </>
          }
        />
      )}

      <div className="border-t border-border pt-2">
        <Row label="Balance" value={loading ? <Skeleton className="h-4 w-24" /> : <Algo value={registry.amount} />} />
        <Row
          label="Spendable"
          value={loading ? <Skeleton className="h-4 w-24" /> : <Algo value={registry.spendable} />}
        />
      </div>

      {!loading &&
        (short ? (
          <Callout variant="danger" title={`Short by ${formatAlgo(registry.shortfall)} ALGO`}>
            At this turnout the registry cannot cover everything it may be asked to fund.
          </Callout>
        ) : (
          <Callout variant="info" title="Fully covered">
            Spendable balance covers the whole requirement, with {formatAlgo(registry.spendable - registry.required)}{' '}
            ALGO to spare.
          </Callout>
        ))}

      <TxButton
        pending={topUp.isPending}
        success={topUp.isSuccess}
        disabled={!short || !activeAddress}
        idleLabel={short ? `Top up ${formatAlgo(registry.shortfall)} ALGO` : 'Nothing to top up'}
        onClick={() => topUp.mutate({ appId: registry.appId, amount: registry.shortfall, label })}
      />
      {short && !activeAddress && <p className="text-xs text-muted-foreground">Connect a wallet to top up.</p>}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1 self-start text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronDown className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
        {open ? 'Hide breakdown' : 'Show breakdown'}
      </button>
      {open && <div className="rounded-md bg-muted/50 p-3">{breakdown}</div>}
    </div>
  )
}

/**
 * `showPooled` follows the frac deployment, not the number: on a network with a frac registry a
 * pooled figure of zero is a real answer worth showing, while on one without there is no such
 * population at all and the card would be a permanent empty row.
 */
function GgovBreakdown({ detail, showPooled }: { detail: GgovMbrEstimate; showPooled: boolean }) {
  return (
    <div className="space-y-3 text-sm">
      <div>
        <p className="font-medium">Voting</p>
        {detail.periods.length === 0 ? (
          <p className="text-xs text-muted-foreground">No ready periods.</p>
        ) : (
          detail.periods.map((p) => (
            <Row
              key={p.periodId}
              label={`Period ${p.periodId} — ${p.voters.toLocaleString()} of ${p.eligible.toLocaleString()} voters × ${formatAlgo(p.perVoter)}`}
              value={<Algo value={p.drain} />}
            />
          ))
        )}
        <p className="pt-1 text-xs text-muted-foreground">
          Each period is topped up in whole chunks, so a drain is rounded up and already nets off what the period app
          holds.
        </p>
      </div>
      <div className="border-t border-border pt-2">
        <p className="font-medium">Delegation</p>
        <Row
          label={`${detail.undelegatedAccounts.toLocaleString()} eligible accounts not yet delegating`}
          value={<Algo value={detail.delegationNeed} />}
        />
        <p className="pt-1 text-xs text-muted-foreground">
          Always costed at 100% — the requirement is that every eligible account <em>can</em> delegate, so the turnout
          assumption does not apply here.
        </p>
      </div>
      {showPooled && (
        <div className="border-t border-border pt-2">
          <p className="font-medium">Pooled delegation</p>
          <Row
            label={`${detail.undelegatedPooledAccounts.toLocaleString()} pool accounts not yet delegating`}
            value={<Algo value={detail.pooledDelegationNeed} />}
          />
          <p className="pt-1 text-xs text-muted-foreground">
            AlgoQuarters holders known only to the fractional registry. They may delegate too, and the boxes land here —
            delegation is a gGov registry action whoever vouches for the delegator. Accounts on both registries are
            counted once, above.
          </p>
        </div>
      )}
    </div>
  )
}

function FracBreakdown({ detail }: { detail: FracMbrEstimate }) {
  if (detail.instances.length === 0) {
    return <p className="text-xs text-muted-foreground">No pools hold power in any ready period.</p>
  }
  return (
    <div className="space-y-1 text-sm">
      {detail.instances.map((i) => (
        <Row
          key={i.instanceNumId}
          label={`${i.name} — ${i.voters.toLocaleString()} voters`}
          value={<Algo value={i.drain} />}
        />
      ))}
      <p className="pt-1 text-xs text-muted-foreground">
        Pooled votes only. Delegation is a gGov registry action, so its cost sits entirely on that side.
      </p>
    </div>
  )
}

export default function RegistryFundingPanel() {
  const [turnoutPct, setTurnoutPct] = useState(100)
  const { ggov, frac, countedPeriodCount, isLoading } = useMbrEstimates(turnoutPct)

  return (
    <Surface className="p-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">Registry funding</h2>
          <p className="text-sm text-muted-foreground">
            What each registry must be able to supply for every voter in {countedPeriodCount}{' '}
            {countedPeriodCount === 1 ? 'ready period' : 'ready periods'} — open or still upcoming — and every eligible
            account delegating — pool accounts included. Drafts are not counted.
          </p>
        </div>
        <div className="w-full max-w-56">
          <div className="flex items-baseline justify-between">
            <Eyebrow>Turnout</Eyebrow>
            <span className="text-sm font-medium tabular-nums">{turnoutPct}%</span>
          </div>
          <Slider
            value={[turnoutPct]}
            onValueChange={([v]) => setTurnoutPct(v)}
            min={0}
            max={100}
            step={5}
            aria-label="Assumed voter turnout"
            className="mt-2"
          />
        </div>
      </div>

      <div className="mt-5 flex flex-col gap-6 md:flex-row md:gap-8">
        <RegistryColumn
          title="gGov registry"
          label="gGov"
          registry={ggov}
          loading={isLoading}
          solo={!frac}
          breakdown={<GgovBreakdown detail={ggov.detail} showPooled={frac !== null} />}
        />
        {frac && (
          <>
            <div className="hidden w-px shrink-0 bg-border md:block" />
            <RegistryColumn
              title="Fractional registry"
              label="fractional"
              registry={frac}
              loading={isLoading}
              breakdown={<FracBreakdown detail={frac.detail} />}
            />
          </>
        )}
      </div>

      <p className="mt-4 text-xs text-muted-foreground">
        Excludes admin-triggered costs that are budgeted separately: AlgoQuarter ingestion, committee ingestion, and the
        MBR a registry locks when it creates a period or instance app.
      </p>
    </Surface>
  )
}
