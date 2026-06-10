import { useQuery, UseQueryResult } from '@tanstack/react-query'
import { create, indexedResolver, windowedFiniteBatchScheduler } from '@yornaath/batshit'
import { getAlgodConfigFromViteEnvironment } from '@/utils/network'

type NFDRecord = {
  name: string
  /** Verified connected Algorand accounts. An address is only "owned" by this NFD if it is listed here. */
  caAlgo?: string[]
}

const network = getAlgodConfigFromViteEnvironment().network
/** NFD only exists on mainnet and testnet; localnet (and anything else) has no resolver. */
const nfdBaseUrl =
  network === 'mainnet'
    ? 'https://api.nf.domains'
    : network === 'testnet'
      ? 'https://api.testnet.nf.domains'
      : null

const nfdEnabled = nfdBaseUrl !== null

const nfd = create({
  fetcher: async (addresses: string[]): Promise<Record<string, string | null>> => {
    if (!nfdBaseUrl) return {}
    const params = addresses.map((address) => `address=${address}`).join('&')
    const url = `${nfdBaseUrl}/nfd/v2/address?${params}&view=brief&limit=20`
    const response = await fetch(url)
    if (!response.ok) return {}
    const data: Record<string, NFDRecord[]> = await response.json()
    const result: Record<string, string | null> = {}
    for (const address of addresses) {
      const records = data[address] ?? []
      // Only treat the NFD as belonging to this address if the address is a *verified* caAlgo.
      const verified = records.find((record) => record.caAlgo?.includes(address))
      result[address] = verified?.name ?? null
    }
    return result
  },
  resolver: indexedResolver(),
  scheduler: windowedFiniteBatchScheduler({
    windowMs: 10,
    maxBatchSize: 20,
  }),
})

/**
 * Reverse-resolves an Algorand address to its verified NFD `.algo` name, or `null`
 * when none exists. Calls made by many components within a 10ms window are batched
 * into a single NFD request. No-ops (returns `null`) on networks without NFD.
 */
export function useAddressName(address?: string | null): UseQueryResult<string | null> {
  return useQuery({
    queryKey: ['nfd-name', network, address ?? '-'],
    queryFn: () => nfd.fetch(address!),
    enabled: nfdEnabled && !!address,
    gcTime: 1000 * 60 * 60, // 1 hour
    staleTime: 1000 * 60 * 60, // 1 hour
  })
}
