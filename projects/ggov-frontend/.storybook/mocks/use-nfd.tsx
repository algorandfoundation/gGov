/**
 * Storybook mock for `@/hooks/use-nfd`.
 *
 * Aliased in `.storybook/main.ts`. The real hooks fetch NFD profiles from the
 * network on testnet/mainnet; here they resolve synchronously from a small static
 * map so account identities render (two-line name-over-address) with no network.
 */
import type { UseQueryResult } from '@tanstack/react-query'
import { demoAccounts } from './use-wallet-react'

export type NfdProfile = { name: string; avatar: string | null }

/** A couple of demo accounts carry a resolved `.algo` name; everyone else is null. */
const NAMES: Record<string, NfdProfile> = {
  [demoAccounts[0].address]: { name: 'alice.algo', avatar: null },
  [demoAccounts[1].address]: { name: 'bob.algo', avatar: null },
}

function resolved<T>(data: T): UseQueryResult<T> {
  return {
    data,
    error: null,
    isError: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    isFetching: false,
    status: 'success',
    fetchStatus: 'idle',
    refetch: async () => resolved(data),
  } as unknown as UseQueryResult<T>
}

export function useAddressNfd(address?: string | null): UseQueryResult<NfdProfile | null> {
  return resolved(address ? (NAMES[address] ?? null) : null)
}

export function useAddressName(address?: string | null): UseQueryResult<string | null> {
  return resolved(address ? (NAMES[address]?.name ?? null) : null)
}
