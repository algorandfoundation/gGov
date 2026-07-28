import { createContext, useContext, useMemo, type ReactNode } from 'react'
import React from 'react'
import { useWallet } from '@txnlab/use-wallet-react'
import { GGovSDK, GGovReaderSDK } from 'ggov-sdk'
import type { FracDelegationReaderSDK } from 'frac-delegation-sdk'
import { EscregSDK } from '@d13co/escreg-sdk'
import { wrapSignerWithPhase } from '@/lib/transactionPhase'
import { createAlgorandClient, createEscregSDK, createReaderSDK, registryAppId } from '@/lib/readerSdk'
import { fracEnabled, getFracReaderSDK } from '@/lib/fracReaderSdk'

interface GGovSDKContextValue {
  readerSDK: GGovReaderSDK
  sdk: GGovSDK | null
  /** Read-only registry for resolving whether an address is an app escrow (escrow → app ID). */
  escregSDK: EscregSDK
  /**
   * Whether this network has a fractional-delegation (pooled voting) registry.
   * Every pooled query gates on this, so a network without one issues none.
   */
  fracEnabled: boolean
  /**
   * Lazily code-split reader for pooled voting power; resolves null when
   * `fracEnabled` is false. See `lib/fracReaderSdk.ts`.
   */
  getFracReaderSDK: () => Promise<FracDelegationReaderSDK | null>
}

const GGovSDKContext = createContext<GGovSDKContextValue | null>(null)

export function GGovSDKProvider({ children }: { children: ReactNode }) {
  const { activeAddress, transactionSigner } = useWallet()

  const readerSDK = useMemo(() => createReaderSDK(), [])

  // App-escrow lookups are read-only and wallet-independent (see createEscregSDK).
  const escregSDK = useMemo(() => createEscregSDK(), [])

  const sdk = useMemo(() => {
    if (!activeAddress || !transactionSigner) return null
    const algorand = createAlgorandClient()
    return new GGovSDK({
      algorand,
      registryAppId,
      concurrency: 8,
      writerAccount: {
        sender: activeAddress,
        signer: wrapSignerWithPhase(transactionSigner),
      },
    })
  }, [activeAddress, transactionSigner])

  // Pooled-voting reader: both values come from module constants in
  // lib/fracReaderSdk.ts, so there is nothing to construct here — the SDK itself
  // is only imported on first use, by whichever pooled query runs first.
  const resolveFracReaderSDK = useMemo(() => async () => (await getFracReaderSDK()) ?? null, [])

  return React.createElement(
    GGovSDKContext.Provider,
    { value: { readerSDK, sdk, escregSDK, fracEnabled, getFracReaderSDK: resolveFracReaderSDK } },
    children,
  )
}

export function useGGovSDK() {
  const ctx = useContext(GGovSDKContext)
  if (!ctx) throw new Error('useGGovSDK must be used within GGovSDKProvider')
  return ctx
}
