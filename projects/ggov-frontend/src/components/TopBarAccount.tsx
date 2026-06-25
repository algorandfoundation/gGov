import { useState } from 'react'
import { useWallet } from '@txnlab/use-wallet-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import UserDropdown from '@/components/UserDropdown'
import WalletPicker from '@/components/WalletPicker'

/**
 * Compact wallet control shared by the desktop top bar and the mobile drawer
 * footer. Logged out → a "Connect wallet" button + wallet picker dialog; logged
 * in → the {@link UserDropdown} avatar pill (account switcher, account-page link,
 * and disconnect all live inside that menu).
 *
 * `fullWidth` centers the control within its container (used in the mobile drawer
 * footer); `small` collapses the dropdown trigger to just the avatar.
 */
export default function TopBarAccount({ fullWidth = false, small = false }: { fullWidth?: boolean; small?: boolean }) {
  const { activeAddress, activeWallet } = useWallet()
  const [open, setOpen] = useState(false)

  if (activeAddress && activeWallet) {
    if (fullWidth) {
      return (
        <div className="flex w-full justify-center">
          <UserDropdown small={small} />
        </div>
      )
    }
    return <UserDropdown small={small} />
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>Connect wallet</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onClose={() => setOpen(false)} className="max-w-md">
          <DialogHeader>
            <DialogTitle>Connect wallet</DialogTitle>
            <DialogDescription>Choose a wallet to connect to gGov.</DialogDescription>
          </DialogHeader>
          <WalletPicker onClose={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  )
}
