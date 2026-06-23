import { lazy, Suspense, useMemo } from 'react'
import { SupportedWallet, WalletId, WalletManager, WalletProvider } from '@txnlab/use-wallet-react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { GGovSDKProvider } from '@/hooks/useGGovSDK'
import { ErrorDialogProvider } from '@/hooks/useErrorDialog'
import { confirmPhase, resetPhase } from '@/lib/transactionPhase'
import { getAlgodConfigFromViteEnvironment, getKmdConfigFromViteEnvironment } from '@/utils/network'
import Layout from '@/components/Layout'
import LandingLayout from '@/components/LandingLayout'
import { Skeleton } from '@/components/ui/skeleton'
import Home from '@/components/pages/Home'
import VotePeriods from '@/components/pages/vote/VotePeriods'
// Lazy-load the heavier routes so the landing view's chunk doesn't carry the
// TipTap editor (Add/Manage screens) or react-markdown (detail screens).
const VotePeriodDetail = lazy(() => import('@/components/pages/vote/VotePeriodDetail'))
const Delegation = lazy(() => import('@/components/pages/vote/Delegation'))
const Account = lazy(() => import('@/components/pages/vote/Account'))
const ManagePeriods = lazy(() => import('@/components/pages/manage/ManagePeriods'))
const ManagePeriodDetail = lazy(() => import('@/components/pages/manage/ManagePeriodDetail'))
const AddPeriod = lazy(() => import('@/components/pages/manage/AddPeriod'))
const AddTopic = lazy(() => import('@/components/pages/manage/AddTopic'))
const Committees = lazy(() => import('@/components/pages/vote/Committees'))
const CommitteeDetail = lazy(() => import('@/components/pages/vote/CommitteeDetail'))
// Public docs site — its own shell (DocsLayout), independent of the app Layout.
const DocsLayout = lazy(() => import('@/components/DocsLayout'))
const DocsHome = lazy(() => import('@/components/pages/docs/DocsHome'))
const DocsGettingStarted = lazy(() => import('@/components/pages/docs/GettingStarted'))
const DocsVotingPower = lazy(() => import('@/components/pages/docs/VotingPower'))
const DocsCommittees = lazy(() => import('@/components/pages/docs/Committees'))
const DocsPeriods = lazy(() => import('@/components/pages/docs/Periods'))
const DocsDelegation = lazy(() => import('@/components/pages/docs/Delegation'))
const DocsFaq = lazy(() => import('@/components/pages/docs/Faq'))

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      console.error(`Query failed [${JSON.stringify(query.queryKey)}]:`, error)
    },
  }),
  // Drive the global transaction phase from every transaction mutation's lifecycle
  // so buttons can flash signing → sending → confirmed without each mutation opting
  // in. Mutations that don't submit a transaction can set
  // `meta: { skipTransactionPhase: true }` to stay out of this (today all do).
  mutationCache: new MutationCache({
    onMutate: (_vars, mutation) => {
      if (!mutation.meta?.skipTransactionPhase) resetPhase() // clear any stale 'confirmed' from a prior run
    },
    onError: (_err, _vars, _ctx, mutation) => {
      if (!mutation.meta?.skipTransactionPhase) resetPhase()
    },
    onSuccess: (_data, _vars, _ctx, mutation) => {
      if (!mutation.meta?.skipTransactionPhase) confirmPhase() // 'confirmed' flash, then auto-resets to idle
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
                <Route element={<LandingLayout />}>
                  <Route index element={<Home />} />
                </Route>
                <Route element={<Layout />}>
                  <Route path="vote" element={<VotePeriods />} />
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
                <Route
                  path="docs"
                  element={
                    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
                      <DocsLayout />
                    </Suspense>
                  }
                >
                  <Route index element={<DocsHome />} />
                  <Route path="getting-started" element={<DocsGettingStarted />} />
                  <Route path="voting-power" element={<DocsVotingPower />} />
                  <Route path="committees" element={<DocsCommittees />} />
                  <Route path="periods" element={<DocsPeriods />} />
                  <Route path="delegation" element={<DocsDelegation />} />
                  <Route path="faq" element={<DocsFaq />} />
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
