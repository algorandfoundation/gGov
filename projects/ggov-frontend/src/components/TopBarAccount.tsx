import { useState } from 'react'
import { useWallet } from '@txnlab/use-wallet-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import UserDropdown from '@/components/UserDropdown'

/**
 * Compact wallet control shared by the desktop top bar and the mobile drawer
 * footer. Logged out → a "Connect wallet" button + wallet picker dialog; logged
 * in → the {@link UserDropdown} avatar pill (account switcher, account-page link,
 * and disconnect all live inside that menu).
 *
 * `fullWidth` centers the control within its container (used in the mobile drawer
 * footer); `small` collapses the dropdown trigger to just the avatar.
 */
export default function TopBarAccount({ fullWidth = false, small = false }: { fullWidth?: boolean, small?: boolean }) {
  const { activeAddress, activeWallet, wallets } = useWallet()
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
