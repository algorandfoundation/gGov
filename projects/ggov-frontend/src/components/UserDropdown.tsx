import { Link } from 'react-router-dom'
import { useWallet } from '@txnlab/use-wallet-react'
import { Check, ChevronDown, LogOut, UserCircle, Wallet } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { AccountAvatar } from '@/components/AccountAvatar'
import { useAddressName } from '@/hooks/use-nfd'
import { ellipseAddress } from '@/utils/ellipseAddress'
import { cn } from '@/lib/utils'

/**
 * Connected-wallet control: an avatar pill that opens a dropdown with the active
 * account's identity, an account switcher (only when the wallet exposes more than
 * one account), a link to the account page, and a disconnect action. Inspired by
 * TxnLab's use-wallet-ui, styled within the Algorand design system.
 *
 * `small` drops the inline address label so the trigger collapses to just the
 * avatar — used in the mobile top bar and drawer footer. `modal={false}` keeps the
 * menu interactive when it is nested inside the mobile navigation sheet.
 */
export default function UserDropdown({ small = false }: { small?: boolean }) {
  const { activeAddress, activeWallet, activeWalletAccounts } = useWallet()
  const { data: nfd } = useAddressName(activeAddress)
  if (!activeAddress || !activeWallet) return null

  const accounts = activeWalletAccounts ?? []
  const ellipsed = ellipseAddress(activeAddress, 6)
  const triggerLabel = nfd ?? ellipseAddress(activeAddress, undefined, small)
  const headerLabel = nfd ?? ellipsed

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Open account menu"
          className="group flex items-center gap-2 rounded-full border border-border py-1 pl-1 pr-2.5 transition-colors hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:border-foreground/30"
        >
          <AccountAvatar address={activeAddress} name={triggerLabel} size={28} />
          {!small && <span className="max-w-[140px] truncate text-sm">{triggerLabel}</span>}
          <ChevronDown className="size-4 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" sideOffset={8} collisionPadding={8} className="w-64">
        {/* Identity header — avatar, name/address, and the connected wallet (Wallet icon decoration). */}
        <div className="flex items-center gap-3 px-2 py-1.5">
          <AccountAvatar address={activeAddress} name={headerLabel} size={40} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-foreground">{headerLabel}</div>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Wallet className="size-3 shrink-0 text-algo-teal" />
              <span className="truncate">{activeWallet.metadata.name}</span>
              {nfd && <span className="truncate font-mono">· {ellipsed}</span>}
            </div>
          </div>
        </div>

        {/* Account switcher — only when there's more than one account to switch between. */}
        {accounts.length > 1 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Switch account</DropdownMenuLabel>
            <DropdownMenuGroup className="max-h-60 overflow-y-auto">
              {accounts.map((account) => (
                <AccountSwitcherItem
                  key={account.address}
                  account={account}
                  isActive={account.address === activeAddress}
                  // Keep the menu open on switch so the active checkmark and header update in place.
                  onSelect={(event) => {
                    event.preventDefault()
                    if (account.address !== activeAddress) activeWallet.setActiveAccount(account.address)
                  }}
                />
              ))}
            </DropdownMenuGroup>
          </>
        )}

        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to={`/account/${activeAddress}`}>
            <UserCircle />
            <span>Go to my account</span>
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={() => activeWallet.disconnect()}>
          <LogOut />
          <span>Disconnect</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Cap a name so a long value (e.g. a very long NFD) can't crowd out the account name. */
function shortenName(name: string, max = 16): string {
  return name.length > max ? `${name.slice(0, max - 1).trimEnd()}…` : name
}

/**
 * One row in the account switcher: an identity prefix — the account's NFD name
 * (ellipsised when long) or a short ellipsised address (e.g. "ABCDEF..") — followed
 * by the wallet-local account name (e.g. "Lute Wallet 1"). Each row resolves its own
 * NFD, so it lives in its own component to keep the hook out of the render loop.
 */
function AccountSwitcherItem({
  account,
  isActive,
  onSelect,
}: {
  account: { address: string; name?: string }
  isActive: boolean
  onSelect: (event: Event) => void
}) {
  const { data: nfd } = useAddressName(account.address)
  const identity = nfd ? shortenName(nfd) : ellipseAddress(account.address, 6, true)
  // Skip the account name when it's empty or just echoes the address (some wallets do this).
  const accountName = account.name && account.name !== account.address ? account.name : null

  return (
    <DropdownMenuItem onSelect={onSelect} className={cn('gap-2', isActive && 'bg-accent/50')}>
      <AccountAvatar address={account.address} name={nfd ?? accountName ?? account.address} size={22} />
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className={cn('shrink-0', nfd ? 'font-medium' : 'font-mono text-xs')}>{identity}</span>
        {accountName && <span className="truncate text-muted-foreground">{accountName}</span>}
      </span>
      {isActive && <Check className="ml-auto size-4 shrink-0 text-primary" />}
    </DropdownMenuItem>
  )
}
