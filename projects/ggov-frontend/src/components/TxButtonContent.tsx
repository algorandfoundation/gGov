import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useWallet } from '@txnlab/use-wallet-react'
import { Check, Loader2 } from 'lucide-react'
import { useTransactionPhase } from '@/lib/transactionPhase'

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
 * Phase-aware label for a transaction button. Reads the global transaction phase
 * but only reacts to the button that triggered the current flow: it tracks whether
 * *this* button was the one pending in the current cycle, so a sibling button whose
 * mutation succeeded earlier (its `isSuccess` stays true) can't piggy-back on the
 * global `confirmed` flash.
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

  // Did *this* button just finish its own pending cycle? Set when pending goes
  // true → false, cleared once the global phase settles back to idle. This keeps
  // the ✓ flash local to the button that ran, independent of stale `isSuccess`.
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
    // Once the confirmed flash ends (or a failure resets us), drop the local flag.
    if (phase === 'idle' && justCompleted) setJustCompleted(false)
  }, [phase, justCompleted])

  if (pending) {
    return (
      <>
        <Loader2 className="animate-spin" />
        {phase === 'signing' ? `Sign in ${walletName ?? 'wallet'}…` : pendingLabel}
      </>
    )
  }

  if (success && justCompleted && phase === 'confirmed') {
    return (
      <>
        <Check />
        {confirmedLabel}
      </>
    )
  }

  return <>{idleLabel}</>
}
