import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { encodeAddress, getApplicationAddress } from 'algosdk'
import { FracPipelinePlugin, type AQCommittee, type AQResultMap, type FracInstanceNameResultMap } from './base.ts'

export const TALGO_APP_ID_MAINNET = 2537013674n

/** tALGO is a single staking instance, so every escrow it exposes resolves to this one name. */
export const TALGO_INSTANCE_NAME = 'Tinyman tALGO'

export class TalgoPipelinePlugin extends FracPipelinePlugin {
  public static readonly source = 'talgo'
  public readonly name = TalgoPipelinePlugin.source

  protected readonly appId: bigint
  protected readonly appAddress: string

  constructor(algorand: AlgorandClient, overrides?: Record<string, unknown>) {
    super(algorand, overrides)
    let appId = TALGO_APP_ID_MAINNET
    // TODO export a util in algokit-utils to validate positive integers, so we don't have to repeat this logic in every plugin
    // support both number and bigint, since the app id is a 32-bit integer but the plugin may be given a bigint override
    if (overrides && 'appId' in overrides) {
      const override = overrides.appId
      const isPositiveInt =
        (typeof override === 'bigint' && override > 0n) ||
        (typeof override === 'number' && Number.isSafeInteger(override) && override > 0)
      if (!isPositiveInt) throw new Error(`talgo: appId override must be a positive integer, got ${String(override)}`)
      appId = BigInt(override as number | bigint)
    }
    this.appId = appId
    this.appAddress = getApplicationAddress(appId).toString()
  }

  async init(): Promise<void> {}

  public async getInstanceNameFromEscrowAddrs(escrowAddrs: string[]): Promise<FracInstanceNameResultMap> {
    const talgoEscrows = new Set(await this.getAllTalgoEscrowAddrs())
    const result: FracInstanceNameResultMap = {}
    // escrows that are not tALGO escrows belong to another source, so they are left out of the map
    for (const addr of escrowAddrs) {
      if (talgoEscrows.has(addr)) result[addr] = TALGO_INSTANCE_NAME
    }
    return result
  }

  /**
   *
   * @returns escrow addresses in `account_N` slot order
   */
  protected async getAllTalgoEscrowAddrs(): Promise<string[]> {
    // the escrows are the accounts stored in the tALGO app global state
    const state = await this.algorand.app.getGlobalState(this.appId)
    const escrows = Object.entries(state)
      .filter(([key]) => key.startsWith('account_'))
      // stable escrow order across runs - sort in slot order, so escrow indices track account_N
      .sort(([a], [b]) => Number(a.slice('account_'.length)) - Number(b.slice('account_'.length)))
      // narrow to byte-typed entries and filter out empty slots which would otherwise decode to the zero address
      .flatMap(([, v]) => ('valueRaw' in v && v.valueRaw.some((byte) => byte !== 0) ? [encodeAddress(v.valueRaw)] : []))
    // account_0 is the app itself and is always set, so an empty result means the wrong app id
    if (!escrows.length) throw new Error(`talgo: app ${this.appId} exposes no account_* globals`)
    if (escrows[0] !== this.appAddress) throw new Error(`talgo: account_0 must be the app address`)
    return escrows
  }

  public async calculateCommitteeAQ<T>(_committee: AQCommittee, _internalId?: T): Promise<AQResultMap> {
    // TODO implement
    return {}
  }
}
