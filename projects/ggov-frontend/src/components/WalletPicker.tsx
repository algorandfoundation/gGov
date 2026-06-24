import { useState } from 'react'
import { useWallet } from '@txnlab/use-wallet-react'
import { useErrorDialog } from '@/hooks/useErrorDialog'
import { WalletTile } from '@/components/ui/wallet-tile'

/**
 * The single connect-wallet picker, shared by the top bar and the sidebar. Renders a
 * 2×2 grid of {@link WalletTile} with per-tile "Connecting…" state and connect-error
 * handling (routed through the error dialog, which downgrades user-rejection to a
 * toast). `onConnected` fires on a successful connect so the host dialog can close.
 */
export default function WalletPicker({ onConnected }: { onConnected?: () => void }) {
  const { wallets } = useWallet()
  const { showError } = useErrorDialog()
  const [connectingId, setConnectingId] = useState<string | null>(null)

  async function connect(wallet: (typeof wallets)[number]) {
    setConnectingId(wallet.id)
    try {
      await wallet.connect()
      onConnected?.()
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
