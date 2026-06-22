import { useQuery, UseQueryResult } from '@tanstack/react-query'
import { create, indexedResolver, windowedFiniteBatchScheduler } from '@yornaath/batshit'
import { getAlgodConfigFromViteEnvironment } from '@/utils/network'

type NFDRecord = {
  name: string
  /** Verified connected Algorand accounts. An address is only "owned" by this NFD if it is listed here. */
  caAlgo?: string[]
  properties?: {
    /** Avatar verified against an NFT the owner holds; an `ipfs://` URL. Preferred over userDefined. */
    verified?: { avatar?: string }
    /** Owner-set avatar; usually already an `https://images.nf.domains/avatar/…` URL. */
    userDefined?: { avatar?: string }
  }
}

/** Resolved NFD identity for an address: the verified `.algo` name plus an optional avatar URL. */
export type NfdProfile = { name: string; avatar: string | null }

/** Turn an `ipfs://CID[/path]` avatar into an https URL via NFD's gateway; pass https through, else null. */
function ipfsToHttp(url: string | undefined): string | null {
  if (!url) return null
  if (url.startsWith('ipfs://')) return `https://images.nf.domains/ipfs/${url.slice('ipfs://'.length)}`
  if (url.startsWith('https://')) return url
  return null
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
  fetcher: async (addresses: string[]): Promise<Record<string, NfdProfile | null>> => {
    if (!nfdBaseUrl) return {}
    const params = addresses.map((address) => `address=${address}`).join('&')
    const url = `${nfdBaseUrl}/nfd/v2/address?${params}&view=brief&limit=20`
    const response = await fetch(url)
    if (!response.ok) return {}
    const data: Record<string, NFDRecord[]> = await response.json()
    const result: Record<string, NfdProfile | null> = {}
    for (const address of addresses) {
      const records = data[address] ?? []
      // Only treat the NFD as belonging to this address if the address is a *verified* caAlgo.
      const record = records.find((record) => record.caAlgo?.includes(address))
      // Prefer the verified (NFT-backed) avatar; fall back to the owner-set one.
      const avatar = record
        ? ipfsToHttp(record.properties?.verified?.avatar ?? record.properties?.userDefined?.avatar)
        : null
      result[address] = record ? { name: record.name, avatar } : null
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
 * Reverse-resolves an Algorand address to its verified NFD profile (`.algo` name +
 * optional avatar URL), or `null` when none exists. Calls made by many components
 * within a 10ms window are batched into a single NFD request. No-ops (returns `null`)
 * on networks without NFD.
 */
export function useAddressNfd(address?: string | null): UseQueryResult<NfdProfile | null> {
  return useQuery({
    queryKey: ['nfd', network, address ?? '-'],
    queryFn: async () => {
      try {
        return (await nfd.fetch(address!)) ?? null
      } catch {
        return null
      }
    },
    enabled: nfdEnabled && !!address,
    gcTime: 1000 * 60 * 60, // 1 hour
    staleTime: 1000 * 60 * 60, // 1 hour
  })
}

/**
 * Convenience wrapper over {@link useAddressNfd} returning just the verified NFD `.algo`
 * name (or `null`). Shares one query/cache entry with `useAddressNfd` — no extra fetch.
 */
export function useAddressName(address?: string | null): UseQueryResult<string | null> {
  return useQuery({
    queryKey: ['nfd', network, address ?? '-'],
    queryFn: () => nfd.fetch(address!),
    enabled: nfdEnabled && !!address,
    gcTime: 1000 * 60 * 60, // 1 hour
    staleTime: 1000 * 60 * 60, // 1 hour
    select: (profile) => profile?.name ?? null,
  })
}
