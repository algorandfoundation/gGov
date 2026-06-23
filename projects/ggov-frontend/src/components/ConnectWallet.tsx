import { useState } from 'react'
import { useWallet } from '@txnlab/use-wallet-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import UserDropdown from '@/components/UserDropdown'
import WalletPicker from '@/components/WalletPicker'

/**
 * Sidebar wallet control. Logged out → a "Connect wallet" button + the shared
 * {@link WalletPicker} dialog; logged in → the {@link UserDropdown} account menu
 * (the account switcher + disconnect live there, replacing the old native
 * `<select>` + Disconnect button).
 */
export default function ConnectWallet() {
  const { activeAddress, activeWallet } = useWallet()
  const [open, setOpen] = useState(false)

  if (activeAddress && activeWallet) {
    return (
      <div className="flex w-full justify-center">
        <UserDropdown />
      </div>
    )
  }

  return (
    <>
      <Button className="w-full" onClick={() => setOpen(true)}>Connect wallet</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onClose={() => setOpen(false)} className="max-w-md">
          <DialogHeader>
            <DialogTitle>Connect wallet</DialogTitle>
            <DialogDescription>Choose a wallet to connect to gGov.</DialogDescription>
          </DialogHeader>
          <WalletPicker onConnected={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  )
}
