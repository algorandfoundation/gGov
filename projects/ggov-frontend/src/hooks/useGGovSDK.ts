import { createContext, useContext, useMemo, type ReactNode } from 'react'
import React from 'react'
import { useWallet } from '@txnlab/use-wallet-react'
import { GGovSDK, GGovReaderSDK } from 'ggov-sdk'
import type { FracDelegationReaderSDK, FracDelegationSDK } from 'frac-delegation-sdk'
import { EscregSDK } from '@d13co/escreg-sdk'
import { wrapSignerWithPhase } from '@/lib/transactionPhase'
import { createAlgorandClient, createEscregSDK, createReaderSDK, registryAppId } from '@/lib/readerSdk'
import { createFracSDK, fracEnabled, getFracReaderSDK } from '@/lib/fracReaderSdk'

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
  /**
   * Writer-enabled frac SDK for casting a pooled ballot, signed by the connected
   * wallet. Resolves null when `fracEnabled` is false or no wallet is connected.
   */
  getFracSDK: () => Promise<FracDelegationSDK | null>
}

const GGovSDKContext = createContext<GGovSDKContextValue | null>(null)

export function GGovSDKProvider({ children }: { children: ReactNode }) {
  const { activeAddress, transactionSigner } = useWallet()

  const readerSDK = useMemo(() => createReaderSDK(), [])

  // App-escrow lookups are read-only and wallet-independent (see createEscregSDK).
  const escregSDK = useMemo(() => createEscregSDK(), [])

  // No `emptyTxnSigner` on either writerAccount below. The SDK uses one to price the AVM v13
  // post-quantum fee premium during its sizing simulates — the surcharge is charged off the
  // signature envelope, so a plain empty signer measures a PQ writer's group as classic — but
  // building one needs the account's PQ scheme and public key, and @txnlab/use-wallet exposes
  // neither: as of v5.0.0 `WalletAccount` is still `{ name, address, metadata? }` and `BaseWallet`
  // has only `transactionSigner`. A PQ user still succeeds; the executor's send-time fee-shortfall
  // retry re-prices the group, at the cost of one extra round trip.
  //
  // When a wallet does expose it: pass it through here, NOT through `wrapSignerWithPhase`. That
  // wrapper flips the global phase to 'signing', and TxButtonContent would render "Sign in <wallet>"
  // for a sizing simulate that never prompts anyone.
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

  // Writer counterpart. Constructed at most once per wallet identity: the memo is
  // keyed on the wallet, and the promise is created on first use and reused after,
  // so repeat pooled votes don't rebuild the SDK (or re-run the dynamic import).
  const resolveFracSDK = useMemo(() => {
    let pending: Promise<FracDelegationSDK | null> | null = null
    return async () => {
      if (!activeAddress || !transactionSigner) return null
      pending ??= Promise.resolve(
        createFracSDK({ sender: activeAddress, signer: wrapSignerWithPhase(transactionSigner) }),
      )
      return pending
    }
  }, [activeAddress, transactionSigner])

  return React.createElement(
    GGovSDKContext.Provider,
    {
      value: {
        readerSDK,
        sdk,
        escregSDK,
        fracEnabled,
        getFracReaderSDK: resolveFracReaderSDK,
        getFracSDK: resolveFracSDK,
      },
    },
    children,
  )
}

export function useGGovSDK() {
  const ctx = useContext(GGovSDKContext)
  if (!ctx) throw new Error('useGGovSDK must be used within GGovSDKProvider')
  return ctx
}
