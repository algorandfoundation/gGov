/**
 * Storybook mock for `@txnlab/use-wallet-react`.
 *
 * Aliased in `.storybook/main.ts`, so every component under test imports this
 * `useWallet` instead of the real one. It is backed by a small interactive
 * provider (`MockWalletProvider`) configured per-story via `parameters.wallet`,
 * so the connected/disconnected, single/multi-account states all render — and
 * switching accounts / disconnecting actually update in place — with no real
 * wallet, signer, or network.
 */
import { createContext, useContext, useState, type ReactNode } from 'react'

export interface MockAccount {
  address: string
  name: string
}

export interface MockWalletConfig {
  /** Provider name shown as the connected wallet, e.g. "Lute" / "Pera". */
  walletName?: string
  /** Accounts the wallet exposes once connected. */
  accounts?: MockAccount[]
  /** Start connected? Defaults to true when `accounts` are provided. */
  connected?: boolean
  /** Initial active address (defaults to the first account). */
  activeAddress?: string
  /** Provider names offered in the picker while disconnected. */
  pickerWallets?: string[]
}

interface MockWallet {
  id: string
  metadata: { name: string; icon: string }
  setActiveAccount: (address: string) => void
  disconnect: () => Promise<void>
}

interface WalletValue {
  activeAddress: string | null
  activeWallet: MockWallet | null
  activeWalletAccounts: MockAccount[] | null
  wallets: Array<{ id: string; metadata: { name: string; icon: string }; connect: () => Promise<void> }>
}

const WalletCtx = createContext<WalletValue | null>(null)

export function useWallet(): WalletValue {
  const ctx = useContext(WalletCtx)
  if (!ctx) throw new Error('mock useWallet() used outside <MockWalletProvider>')
  return ctx
}

/** Build a 58-char Algorand-looking address with the given visible head/tail. */
function addr(head6: string, tail6: string): string {
  const filler = 'PQ4MORSTUV2WXYZ34567ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDE'
  return (head6 + filler).slice(0, 52) + tail6
}

/** A few stable demo accounts reused across stories. */
export const demoAccounts: MockAccount[] = [
  { address: addr('R2CY2O', 'Y664QM'), name: 'Lute Wallet 1' },
  { address: addr('ZBMMA4', 'S4BVYU'), name: 'Lute Wallet 2' },
  { address: addr('7TMAQX', 'R4RAGQ'), name: 'Lute Wallet 3' },
]

export function MockWalletProvider({
  config = {},
  children,
}: {
  config?: MockWalletConfig
  children: ReactNode
}) {
  const accounts = config.accounts ?? []
  const startConnected = config.connected ?? accounts.length > 0
  const walletName = config.walletName ?? 'Lute'
  const [activeAddress, setActiveAddress] = useState<string | null>(
    startConnected ? config.activeAddress ?? accounts[0]?.address ?? null : null,
  )

  const activeWallet: MockWallet | null = activeAddress
    ? {
        id: 'mock',
        metadata: { name: walletName, icon: '' },
        setActiveAccount: (a) => setActiveAddress(a),
        disconnect: async () => setActiveAddress(null),
      }
    : null

  const wallets = (config.pickerWallets ?? ['Pera', 'Defly', 'Exodus', 'Lute']).map((name) => ({
    id: name.toLowerCase(),
    metadata: { name, icon: '' },
    connect: async () => setActiveAddress(config.activeAddress ?? accounts[0]?.address ?? demoAccounts[0].address),
  }))

  const value: WalletValue = {
    activeAddress,
    activeWallet,
    activeWalletAccounts: activeAddress ? accounts : null,
    wallets,
  }

  return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>
}

/** Passthrough so any incidental `WalletProvider` import resolves harmlessly. */
export function WalletProvider({ children }: { children: ReactNode }) {
  return <>{children}</>
}
