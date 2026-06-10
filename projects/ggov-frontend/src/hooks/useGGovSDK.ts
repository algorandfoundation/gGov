import { createContext, useContext, useMemo, type ReactNode } from 'react'
import React from 'react'
import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { useWallet } from '@txnlab/use-wallet-react'
import { GGovSDK, GGovReaderSDK } from 'ggov-sdk'
import { getAlgodConfigFromViteEnvironment } from '@/utils/network'

interface GGovSDKContextValue {
  readerSDK: GGovReaderSDK
  sdk: GGovSDK | null
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

export function GGovSDKProvider({ children }: { children: ReactNode }) {
  const { activeAddress, transactionSigner } = useWallet()

  const readerSDK = useMemo(() => {
    const algorand = createAlgorandClient()
    return new GGovReaderSDK({ algorand, ggovRegistryAppId: appId })
  }, [])

  const sdk = useMemo(() => {
    if (!activeAddress || !transactionSigner) return null
    const algorand = createAlgorandClient()
    return new GGovSDK({
      algorand,
      ggovRegistryAppId: appId,
      writerAccount: {
        sender: activeAddress,
        signer: transactionSigner,
      },
    })
  }, [activeAddress, transactionSigner])

  return React.createElement(
    GGovSDKContext.Provider,
    { value: { readerSDK, sdk } },
    children
  )
}

export function useGGovSDK() {
  const ctx = useContext(GGovSDKContext)
  if (!ctx) throw new Error('useGGovSDK must be used within GGovSDKProvider')
  return ctx
}
