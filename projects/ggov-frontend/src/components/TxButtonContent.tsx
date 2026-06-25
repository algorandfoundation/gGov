/* eslint-disable react-refresh/only-export-components */
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { useWallet } from '@txnlab/use-wallet-react'
import { Check, Loader2 } from 'lucide-react'
import { useTransactionPhase } from '@/lib/transactionPhase'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface TxButtonContentProps {
  /** Whether *this* button's mutation is currently running. */
  pending: boolean
  /** Whether this button opts into the post-success ✓ flash (pass the mutation's `isSuccess`). */
  success?: boolean
  idleLabel: ReactNode
  /** Shown while pending and not in the wallet-signing phase. Defaults to "Sending…". */
  pendingLabel?: ReactNode
  /** Shown during the brief confirmed flash. Defaults to "Submitted". */
  confirmedLabel?: ReactNode
}

/**
 * Whether *this* button is in its post-success ✓ flash. Tracks whether this button
 * was the one pending in the current cycle (pending true → false) and the global
 * `confirmed` phase, so the flash stays local to the button that ran — a sibling
 * whose `isSuccess` is stale can't piggy-back on the global flash.
 */
export function useConfirmedFlash(pending: boolean, success?: boolean): boolean {
  const phase = useTransactionPhase()
  const wasPending = useRef(false)
  const [justCompleted, setJustCompleted] = useState(false)

  useEffect(() => {
    if (pending) {
      wasPending.current = true
      setJustCompleted(false)
    } else if (wasPending.current) {
      wasPending.current = false
      setJustCompleted(true)
    }
  }, [pending])

  useEffect(() => {
    if (phase === 'idle' && justCompleted) setJustCompleted(false)
  }, [phase, justCompleted])

  return !!success && justCompleted && phase === 'confirmed'
}

/**
 * Phase-aware label for a transaction button: spinner + "Sign in {Wallet}…" while
 * the wallet prompt is open, spinner + `pendingLabel` while sending, a ✓ +
 * `confirmedLabel` during the confirmed flash, else `idleLabel`.
 */
export function TxButtonContent({
  pending,
  success,
  idleLabel,
  pendingLabel = 'Sending…',
  confirmedLabel = 'Submitted',
}: TxButtonContentProps) {
  const phase = useTransactionPhase()
  const { activeWallet } = useWallet()
  const walletName = activeWallet?.metadata.name
  const confirmed = useConfirmedFlash(pending, success)

  if (pending) {
    return (
      <>
        <Loader2 className="animate-spin" />
        {phase === 'signing' ? `Sign in ${walletName ?? 'wallet'}…` : pendingLabel}
      </>
    )
  }

  if (confirmed) {
    return (
      <>
        <Check />
        {confirmedLabel}
      </>
    )
  }

  return <>{idleLabel}</>
}

type TxButtonProps = Omit<ComponentProps<typeof Button>, 'children'> & TxButtonContentProps

/**
 * Primary transaction button: a {@link Button} whose label is driven by the phase
 * machine via {@link TxButtonContent}, flashing **green** (with navy text) on the
 * confirmed success state. Disables + sets `aria-busy` while pending. Forwards all
 * Button props (variant, size, onClick, …).
 */
export function TxButton({
  pending,
  success,
  idleLabel,
  pendingLabel,
  confirmedLabel,
  className,
  disabled,
  ...buttonProps
}: TxButtonProps) {
  const confirmed = useConfirmedFlash(pending, success)
  return (
    <Button
      disabled={disabled || pending}
      aria-busy={pending}
      className={cn(confirmed && 'bg-success! text-[#001324]! hover:bg-success!', className)}
      {...buttonProps}
    >
      <TxButtonContent
        pending={pending}
        success={success}
        idleLabel={idleLabel}
        pendingLabel={pendingLabel}
        confirmedLabel={confirmedLabel}
      />
    </Button>
  )
}
