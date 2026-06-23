import type { Meta, StoryObj } from '@storybook/react'
import { useEffect, useState } from 'react'
import { TxButton, TxButtonContent } from '@/components/TxButtonContent'
import { setPhase, confirmPhase, resetPhase, type TransactionPhase } from '@/lib/transactionPhase'
import { Button } from '@/components/ui/button'
import { demoAccounts } from '../../.storybook/mocks/use-wallet-react'

/**
 * §5 — phase-aware transaction button label. Drives a single global phase machine:
 * idle → signing (`Sign in {wallet}…`) → sending (`Sending…`) → confirmed (✓ flash).
 */
const meta: Meta = {
  title: 'MISC_DIALOGS/5. Transaction button',
  // A connected wallet so the signing label reads "Sign in Lute…".
  parameters: { wallet: { walletName: 'Lute', accounts: demoAccounts.slice(0, 1) } },
}
export default meta
type Story = StoryObj

/** Pin the global phase for a static snapshot of one state. */
function PhasedButton({ phase, pending, success }: { phase: TransactionPhase; pending: boolean; success?: boolean }) {
  useEffect(() => {
    setPhase(phase)
    return () => resetPhase()
  }, [phase])
  return (
    <Button disabled={pending} aria-busy={pending}>
      <TxButtonContent pending={pending} success={success} idleLabel="Cast vote" />
    </Button>
  )
}

export const Idle: Story = {
  render: () => <PhasedButton phase="idle" pending={false} />,
}

export const Signing: Story = {
  name: 'Signing (wallet prompt)',
  render: () => <PhasedButton phase="signing" pending />,
}

export const Sending: Story = {
  render: () => <PhasedButton phase="sending" pending />,
}

function InteractiveTxButton() {
  const [pending, setPending] = useState(false)
  const [success, setSuccess] = useState(false)
  const run = () => {
    setSuccess(false)
    setPending(true)
    setPhase('signing')
    setTimeout(() => setPhase('sending'), 900)
    setTimeout(() => {
      setPending(false)
      setSuccess(true)
      confirmPhase()
    }, 1900)
  }
  // Uses TxButton so the confirmed flash shows the green (navy text) state.
  return <TxButton onClick={run} pending={pending} success={success} idleLabel="Cast vote" />
}

export const Interactive: Story = {
  name: 'Interactive — run the full flow (green confirmed)',
  render: () => <InteractiveTxButton />,
}
