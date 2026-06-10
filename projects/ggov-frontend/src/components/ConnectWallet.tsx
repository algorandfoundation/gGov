import { useWallet } from '@txnlab/use-wallet-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ellipseAddress } from '@/utils/ellipseAddress'
import Address from '@/components/Address'

export default function ConnectWallet() {
  const { activeAddress, activeWallet, activeWalletAccounts, wallets } = useWallet()
  const [open, setOpen] = useState(false)

  if (activeAddress && activeWallet) {
    const accounts = activeWalletAccounts ?? []
    const hasMultipleAccounts = accounts.length > 1

    return (
      <div className="flex flex-col gap-2 w-full">
        {hasMultipleAccounts ? (
          <select
            aria-label="Select account"
            name="active-account"
            className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm font-mono text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
          <span className="text-sm text-muted-foreground truncate">
            <Address address={activeAddress} tooltip={false} />
          </span>
        )}
        <Button variant="outline" size="sm" className="w-full" onClick={() => activeWallet.disconnect()}>
          Disconnect
        </Button>
      </div>
    )
  }

  return (
    <>
      <Button className="w-full" onClick={() => setOpen(true)}>Connect Wallet</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onClose={() => setOpen(false)}>
          <DialogHeader>
            <DialogTitle>Connect Wallet</DialogTitle>
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
