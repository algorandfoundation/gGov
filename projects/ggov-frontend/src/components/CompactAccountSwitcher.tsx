import { useWallet } from '@txnlab/use-wallet-react'
import { Avatar } from '@/components/ui/avatar'
import { ellipseAddress } from '@/utils/ellipseAddress'
import { cn } from '@/lib/utils'

/**
 * Compact sibling of {@link AccountSelector}: a radio-card list of the connected
 * wallet's accounts that switches the active (signing) account on select. Renders
 * nothing when the wallet exposes a single account (nothing to switch between).
 */
export default function CompactAccountSwitcher({ className }: { className?: string }) {
  const { activeAddress, activeWallet, activeWalletAccounts } = useWallet()
  const accounts = activeWalletAccounts ?? []
  if (!activeWallet || accounts.length <= 1) return null

  return (
    <div role="radiogroup" aria-label="Switch active account" className={cn('flex flex-col gap-1.5', className)}>
      {accounts.map((account) => {
        const isActive = account.address === activeAddress
        const label = account.name || ellipseAddress(account.address, 4)
        return (
          <button
            key={account.address}
            type="button"
            role="radio"
            aria-checked={isActive}
            onClick={() => {
              if (!isActive) activeWallet.setActiveAccount(account.address)
            }}
            className={cn(
              'flex items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors',
              isActive
                ? 'border-primary bg-primary/5'
                : 'border-border hover:border-foreground/20 hover:bg-muted/50',
            )}
          >
            <span
              className={cn(
                'flex size-4 shrink-0 items-center justify-center rounded-full border-2',
                isActive ? 'border-primary' : 'border-muted-foreground/40',
              )}
            >
              <span
                className={cn('size-2 rounded-full bg-primary transition-opacity', isActive ? 'opacity-100' : 'opacity-0')}
              />
            </span>
            <Avatar name={label} size={24} />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{label}</div>
              <div className="font-mono text-[11px] text-muted-foreground">{ellipseAddress(account.address, 4)}</div>
            </div>
          </button>
        )
      })}
    </div>
  )
}
