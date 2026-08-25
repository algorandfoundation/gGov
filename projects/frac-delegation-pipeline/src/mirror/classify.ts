/**
 * Which mainnet accounts the mirror seed has to substitute (see `substitutions.ts`).
 *
 * - Core governors (committee members): app escrows per escreg that are NOT frac escrows. Pool
 *   escrows stay real: stage 1 recognizes instances by them and stage 2 delegates them.
 * - Frac governors (AQ accounts inside an instance): app escrows per escreg, or Tinyman liquidity
 *   pools — plain accounts rekeyed to the Tinyman pool logic-sig signer.
 * - Either kind: the Algorand Foundation's accounts (`foundation-accounts.ts`), a fixed list.
 */

import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import pMap from 'p-map'
import { FOUNDATION_ACCOUNTS } from './foundation-accounts.ts'
import { TINYMAN_POOL_AUTH_ADDR, type SubstitutionReason } from './substitutions.ts'

/** The slice of `EscregSDK` used here, so tests can stub it. */
export interface EscrowLookup {
  lookup(args: { addresses: string[]; concurrency?: number }): Promise<Record<string, bigint | undefined>>
}

/** The slice of algod used here, so tests can stub it. */
export interface AuthAddrLookup {
  authAddrOf(address: string): Promise<string | undefined>
}

export type Classification = { reason: SubstitutionReason; appId?: bigint }

export function algodAuthAddrLookup(algorand: AlgorandClient): AuthAddrLookup {
  return {
    async authAddrOf(address) {
      const info = await algorand.client.algod.accountInformation(address).do()
      return info.authAddr?.toString()
    },
  }
}

/**
 * Committee members that are Foundation accounts, or app escrows but not frac escrows:
 * `address → classification`.
 */
export async function classifyCoreGovs({
  addresses,
  escrowAddresses,
  escreg,
  concurrency,
  foundation = FOUNDATION_ACCOUNTS,
}: {
  addresses: string[]
  escrowAddresses: Iterable<string>
  escreg: EscrowLookup
  concurrency?: number
  foundation?: Iterable<string>
}): Promise<Map<string, Classification>> {
  const escrows = new Set(escrowAddresses)
  const known = new Set(foundation)
  const out = new Map<string, Classification>()
  const candidates: string[] = []
  for (const address of addresses) {
    if (escrows.has(address)) continue
    if (known.has(address)) out.set(address, { reason: 'foundation' })
    else candidates.push(address)
  }
  const owners = candidates.length ? await escreg.lookup({ addresses: candidates, concurrency }) : {}
  for (const address of candidates) {
    const appId = owners[address]
    if (appId !== undefined) out.set(address, { reason: 'app-escrow', appId })
  }
  return out
}

/**
 * Classifies AQ accounts, remembering every verdict so the same account seen in a second instance
 * costs nothing. The Foundation list first (no I/O), then escreg (one batched simulate), then an
 * algod read per remaining account for the Tinyman pool rekey.
 */
export class FracAccountClassifier {
  private readonly cache = new Map<string, Classification | null>()
  private readonly escreg: EscrowLookup
  private readonly auth: AuthAddrLookup
  private readonly concurrency: number

  // No parameter properties: `--experimental-strip-types` does not support them (see plugins/base.ts)
  constructor(
    escreg: EscrowLookup,
    auth: AuthAddrLookup,
    concurrency = 4,
    foundation: Iterable<string> = FOUNDATION_ACCOUNTS,
  ) {
    this.escreg = escreg
    this.auth = auth
    this.concurrency = concurrency
    for (const address of foundation) this.cache.set(address, { reason: 'foundation' })
  }

  async classify(addresses: string[]): Promise<Map<string, Classification>> {
    const unseen = [...new Set(addresses)].filter((a) => !this.cache.has(a))
    if (unseen.length) {
      const owners = await this.escreg.lookup({ addresses: unseen, concurrency: this.concurrency })
      const notEscrow: string[] = []
      for (const address of unseen) {
        const appId = owners[address]
        if (appId !== undefined) this.cache.set(address, { reason: 'app-escrow', appId })
        else notEscrow.push(address)
      }
      await pMap(
        notEscrow,
        async (address) => {
          const authAddr = await this.auth.authAddrOf(address)
          this.cache.set(address, authAddr === TINYMAN_POOL_AUTH_ADDR ? { reason: 'tinyman-pool' } : null)
        },
        { concurrency: this.concurrency },
      )
    }
    const out = new Map<string, Classification>()
    for (const address of addresses) {
      const verdict = this.cache.get(address)
      if (verdict) out.set(address, verdict)
    }
    return out
  }
}
