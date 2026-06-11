import { useMemo } from 'react'
import { SupportedWallet, WalletId, WalletManager, WalletProvider } from '@txnlab/use-wallet-react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { GGovSDKProvider } from '@/hooks/useGGovSDK'
import { ErrorDialogProvider } from '@/hooks/useErrorDialog'
import { getAlgodConfigFromViteEnvironment, getKmdConfigFromViteEnvironment } from '@/utils/network'
import Layout from '@/components/Layout'
import VotePeriods from '@/components/pages/vote/VotePeriods'
import VotePeriodDetail from '@/components/pages/vote/VotePeriodDetail'
import Delegation from '@/components/pages/vote/Delegation'
import Account from '@/components/pages/vote/Account'
import ManagePeriods from '@/components/pages/manage/ManagePeriods'
import ManagePeriodDetail from '@/components/pages/manage/ManagePeriodDetail'
import AddPeriod from '@/components/pages/manage/AddPeriod'
import AddTopic from '@/components/pages/manage/AddTopic'
import Committees from '@/components/pages/vote/Committees'
import CommitteeDetail from '@/components/pages/vote/CommitteeDetail'

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      console.error(`Query failed [${JSON.stringify(query.queryKey)}]:`, error)
    },
  }),
})

let supportedWallets: SupportedWallet[]
if (import.meta.env.VITE_ALGOD_NETWORK === 'localnet') {
  const kmdConfig = getKmdConfigFromViteEnvironment()
  supportedWallets = [
    {
      id: WalletId.KMD,
      options: {
        baseServer: kmdConfig.server,
        token: String(kmdConfig.token),
        port: String(kmdConfig.port),
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

export default function App() {
  const algodConfig = getAlgodConfigFromViteEnvironment()

  const walletManager = useMemo(() => new WalletManager({
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
  }), [algodConfig.network, algodConfig.server, algodConfig.port, algodConfig.token])

  return (
    <WalletProvider manager={walletManager}>
      <GGovSDKProvider>
        <QueryClientProvider client={queryClient}>
          <ErrorDialogProvider>
           <TooltipProvider>
            <BrowserRouter>
              <Routes>
                <Route element={<Layout />}>
                  <Route index element={<VotePeriods />} />
                  <Route path="vote/period/:periodId" element={<VotePeriodDetail />} />
                  <Route path="vote/delegation" element={<Delegation />} />
                  <Route path="account/:address" element={<Account />} />
                  <Route path="manage" element={<ManagePeriods />} />
                  <Route path="manage/add-period" element={<AddPeriod />} />
                  <Route path="manage/period/:periodId" element={<ManagePeriodDetail />} />
                  <Route path="manage/period/:periodId/add-topic" element={<AddTopic />} />
                  <Route path="committees" element={<Committees />} />
                  <Route path="committees/:committeeId" element={<CommitteeDetail />} />
                </Route>
              </Routes>
            </BrowserRouter>
           </TooltipProvider>
          </ErrorDialogProvider>
          <Toaster position="bottom-right" />
        </QueryClientProvider>
      </GGovSDKProvider>
    </WalletProvider>
  )
}
