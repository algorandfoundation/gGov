import { createContext, useContext, useMemo, type ReactNode } from 'react'
import React from 'react'
import { useWallet } from '@txnlab/use-wallet-react'
import { GGovSDK, GGovReaderSDK } from 'ggov-sdk'
import { EscregSDK } from '@d13co/escreg-sdk'
import { wrapSignerWithPhase } from '@/lib/transactionPhase'
import { createAlgorandClient, createEscregSDK, createReaderSDK, registryAppId } from '@/lib/readerSdk'

interface GGovSDKContextValue {
  readerSDK: GGovReaderSDK
  sdk: GGovSDK | null
  /** Read-only registry for resolving whether an address is an app escrow (escrow → app ID). */
  escregSDK: EscregSDK
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

  return React.createElement(GGovSDKContext.Provider, { value: { readerSDK, sdk, escregSDK } }, children)
}

export function useGGovSDK() {
  const ctx = useContext(GGovSDKContext)
  if (!ctx) throw new Error('useGGovSDK must be used within GGovSDKProvider')
  return ctx
}
