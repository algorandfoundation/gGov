import { createContext, useContext, useMemo, type ReactNode } from 'react'
import React from 'react'
import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { useWallet } from '@txnlab/use-wallet-react'
import { GGovSDK, GGovReaderSDK } from 'ggov-sdk'
import { EscregSDK } from '@d13co/escreg-sdk'
import { getAlgodConfigFromViteEnvironment } from '@/utils/network'
import { wrapSignerWithPhase } from '@/lib/transactionPhase'

interface GGovSDKContextValue {
  readerSDK: GGovReaderSDK
  sdk: GGovSDK | null
  /** Read-only registry for resolving whether an address is an app escrow (escrow → app ID). */
  escregSDK: EscregSDK
}

const GGovSDKContext = createContext<GGovSDKContextValue | null>(null)

function createAlgorandClient() {
  const config = getAlgodConfigFromViteEnvironment()
  return AlgorandClient.fromConfig({
    algodConfig: {
      server: config.server,
      port: config.port,
      token: config.token,
    },
  }).setDefaultValidityWindow(213) // ~10 mins at 2.81 round times
}

const appId = BigInt(import.meta.env.VITE_GGOV_REGISTRY_APP_ID || '0')
const escregAppId = import.meta.env.VITE_ESCREG_APP_ID
  ? BigInt(import.meta.env.VITE_ESCREG_APP_ID)
  : undefined

export function GGovSDKProvider({ children }: { children: ReactNode }) {
  const { activeAddress, transactionSigner } = useWallet()

  const readerSDK = useMemo(() => {
    const algorand = createAlgorandClient()
    return new GGovReaderSDK({ algorand, registryAppId: appId, concurrency: 8 })
  }, [])

  // App-escrow lookups are read-only and wallet-independent. When VITE_ESCREG_APP_ID
  // is set we query that deployment through the app's own Algorand client; otherwise
  // the SDK falls back to its built-in Fnet registry (escrow addresses are
  // network-independent, derived purely from the app ID).
  const escregSDK = useMemo(() => {
    if (escregAppId !== undefined) {
      return new EscregSDK({ appId: escregAppId, algorand: createAlgorandClient() })
    }
    return new EscregSDK({})
  }, [])

  const sdk = useMemo(() => {
    if (!activeAddress || !transactionSigner) return null
    const algorand = createAlgorandClient()
    return new GGovSDK({
      algorand,
      registryAppId: appId,
      concurrency: 8,
      writerAccount: {
        sender: activeAddress,
        signer: wrapSignerWithPhase(transactionSigner),
      },
    })
  }, [activeAddress, transactionSigner])

  return React.createElement(
    GGovSDKContext.Provider,
    { value: { readerSDK, sdk, escregSDK } },
    children
  )
}

export function useGGovSDK() {
  const ctx = useContext(GGovSDKContext)
  if (!ctx) throw new Error('useGGovSDK must be used within GGovSDKProvider')
  return ctx
}
