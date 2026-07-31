import { useMemo, type ReactNode } from 'react'
import { SupportedWallet, WalletId, WalletManager, WalletProvider } from '@txnlab/use-wallet-react'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { GGovSDKProvider } from '@/hooks/useGGovSDK'
import { ErrorDialogProvider } from '@/hooks/useErrorDialog'
import { getAlgodConfigFromViteEnvironment, getKmdConfigFromViteEnvironment } from '@/utils/network'

// Network-dependent wallet set: KMD/Lute on localnet, the production connectors
// elsewhere. use-wallet v4 defers all window/localStorage access (its manager
// guards on `typeof window`), so constructing this during SSR is safe — the
// provider simply renders with no active account on the server.
// Derived from the resolved config (not the raw env) so a no-env checkout —
// which defaults to localnet — gets the localnet wallets, not the production set.
let supportedWallets: SupportedWallet[]
if (getAlgodConfigFromViteEnvironment().network === 'localnet') {
  const kmdConfig = getKmdConfigFromViteEnvironment()
  supportedWallets = [
    {
      id: WalletId.KMD,
      options: {
        baseServer: kmdConfig.server,
        token: String(kmdConfig.token),
        port: String(kmdConfig.port),
        // Which KMD wallet to open. Without this, use-wallet falls back to
        // `unencrypted-default-wallet` and `VITE_KMD_WALLET` is silently ignored —
        // so pointing at a single-persona wallet (the localnet seeder makes one per
        // persona) had no effect. Every account in the opened wallet is treated as a
        // voter, so a one-account wallet is what gives a persona-in-isolation view.
        wallet: kmdConfig.wallet,
      },
    },
    { id: WalletId.LUTE, options: { siteName: 'gGov' } },
  ]
} else {
  supportedWallets = [
    { id: WalletId.PERA },
    { id: WalletId.DEFLY },
    { id: WalletId.EXODUS },
    { id: WalletId.LUTE, options: { siteName: 'gGov' } },
  ]
}

/**
 * Client-state providers shared by every route. QueryClientProvider is supplied
 * one level up by setupRouterSsrQueryIntegration (router.options.Wrap), so this
 * only adds the wallet, SDK, error-dialog and tooltip contexts plus the toaster.
 */
export default function AppProviders({ children }: { children: ReactNode }) {
  const algodConfig = getAlgodConfigFromViteEnvironment()

  const walletManager = useMemo(
    () =>
      new WalletManager({
        wallets: supportedWallets,
        defaultNetwork: algodConfig.network,
        networks: {
          [algodConfig.network]: {
            algod: {
              baseServer: algodConfig.server,
              port: algodConfig.port,
              token: String(algodConfig.token),
            },
          },
        },
        options: {
          resetNetwork: true,
        },
      }),
    [algodConfig.network, algodConfig.server, algodConfig.port, algodConfig.token],
  )

  return (
    <WalletProvider manager={walletManager}>
      <GGovSDKProvider>
        <ErrorDialogProvider>
          <TooltipProvider>
            {children}
            <Toaster position="bottom-right" />
          </TooltipProvider>
        </ErrorDialogProvider>
      </GGovSDKProvider>
    </WalletProvider>
  )
}
