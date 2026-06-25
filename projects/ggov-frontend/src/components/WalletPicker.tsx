import { useState } from 'react'
import { useWallet } from '@txnlab/use-wallet-react'
import { useErrorDialog } from '@/hooks/useErrorDialog'
import { WalletTile } from '@/components/ui/wallet-tile'

/**
 * The single connect-wallet picker, shared by the top bar and the sidebar. Renders a
 * 2×2 grid of {@link WalletTile} with per-tile "Connecting…" state and connect-error
 * handling (routed through the error dialog, which downgrades user-rejection to a
 * toast).
 *
 * `onClose` fires the moment a wallet is picked — BEFORE `wallet.connect()` — so the
 * host Radix `Dialog` unmounts before the wallet's own modal (Defly/Pera) opens.
 * Otherwise the picker's outside-click dismissal treats clicks inside the wallet
 * modal as click-aways, and its `pointer-events: none` body lock leaks onto that
 * modal. (A global override in main.css separately keeps the wallet modal
 * interactive under any *other* still-open overlay — e.g. the mobile sidebar Sheet.)
 * Errors still surface via the app-root error dialog after the picker has unmounted.
 */
export default function WalletPicker({ onClose }: { onClose?: () => void }) {
  const { wallets } = useWallet()
  const { showError } = useErrorDialog()
  const [connectingId, setConnectingId] = useState<string | null>(null)

  async function connect(wallet: (typeof wallets)[number]) {
    setConnectingId(wallet.id)
    // Close the picker before connecting so its outside-click dismissal doesn't fire
    // on clicks inside the wallet's own modal, and its body pointer-events lock lifts.
    onClose?.()
    try {
      await wallet.connect()
    } catch (err) {
      showError(err)
    } finally {
      setConnectingId(null)
    }
  }

  return (
    <div className="grid grid-cols-2 gap-2.5">
      {wallets.map((wallet) => (
        <WalletTile
          key={wallet.id}
          name={wallet.metadata.name}
          icon={wallet.metadata.icon}
          connecting={connectingId === wallet.id}
          disabled={connectingId !== null && connectingId !== wallet.id}
          onClick={() => connect(wallet)}
        />
      ))}
    </div>
  )
}
