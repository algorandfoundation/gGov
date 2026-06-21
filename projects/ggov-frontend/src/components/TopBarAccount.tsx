import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useWallet } from '@txnlab/use-wallet-react'
import { LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AccountAvatar } from '@/components/AccountAvatar'
import { useAddressName } from '@/hooks/use-nfd'
import { ellipseAddress } from '@/utils/ellipseAddress'

/**
 * Compact wallet control shared by the desktop top bar and the mobile drawer
 * footer. Logged out → a "Connect wallet" button + wallet picker dialog; logged
 * in → an account pill (avatar + NFD or truncated address) linking to the account
 * page, with a disconnect affordance.
 *
 * `fullWidth` spans the container, centering the pill and right-aligning the
 * disconnect button (used in the mobile drawer footer).
 */
export default function TopBarAccount({ fullWidth = false }: { fullWidth?: boolean }) {
  const { activeAddress, activeWallet, activeWalletAccounts, wallets } = useWallet()
  const { data: nfd } = useAddressName(activeAddress)
  const [open, setOpen] = useState(false)

  if (activeAddress && activeWallet) {
    const accounts = activeWalletAccounts ?? []
    const label = nfd ?? ellipseAddress(activeAddress)
    const control =
      accounts.length > 1 ? (
        <select
          aria-label="Select account"
          className="h-8 max-w-[150px] rounded-full border border-border bg-transparent px-3 font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          value={activeAddress}
          onChange={(e) => activeWallet.setActiveAccount(e.target.value)}
        >
          {accounts.map((account) => (
            <option key={account.address} value={account.address}>
              {account.name ? `${account.name} (${ellipseAddress(account.address)})` : ellipseAddress(account.address)}
            </option>
          ))}
        </select>
      ) : (
        <Link
          to={`/account/${activeAddress}`}
          className="flex items-center gap-2 rounded-full border border-border py-1 pl-3 pr-1 transition-colors hover:border-foreground/30"
        >
          <span className="text-sm">{label}</span>
          <AccountAvatar address={activeAddress} name={label} size={28} />
        </Link>
      )
    const disconnect = (
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        onClick={() => activeWallet.disconnect()}
        aria-label="Disconnect wallet"
        title="Disconnect wallet"
      >
        <LogOut className="size-4" />
      </Button>
    )

    if (fullWidth) {
      // 1fr | auto | 1fr keeps the pill centered regardless of the disconnect button's width.
      return (
        <div className="grid w-full grid-cols-[1fr_auto_1fr] items-center">
          <span aria-hidden />
          <div className="flex justify-center">{control}</div>
          <div className="flex justify-end">{disconnect}</div>
        </div>
      )
    }

    return (
      <div className="flex items-center gap-1.5">
        {control}
        {disconnect}
      </div>
    )
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>Connect wallet</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onClose={() => setOpen(false)}>
          <DialogHeader>
            <DialogTitle>Connect wallet</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            {wallets.map((wallet) => (
              <Button
                key={wallet.id}
                variant="outline"
                className="justify-start"
                onClick={async () => {
                  await wallet.connect()
                  setOpen(false)
                }}
              >
                {wallet.metadata.name}
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
