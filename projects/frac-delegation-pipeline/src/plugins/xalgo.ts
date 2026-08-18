import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { encodeAddress } from 'algosdk'
import { FracPipelinePlugin, type AQCommittee, type AQResultMap, type FracInstanceNameResultMap } from './base.ts'

export const XALGO_APP_ID_MAINNET = 1134695678n

/** xALGO is a single staking instance, so every escrow it exposes resolves to this one name. */
export const XALGO_INSTANCE_NAME = 'Folks xALGO'

/** Each proposer (escrow) gets one box, keyed `ap` + its 32-byte public key. */
const PROPOSER_BOX_PREFIX = new TextEncoder().encode('ap')
const PROPOSER_BOX_NAME_LENGTH = PROPOSER_BOX_PREFIX.length + 32

export class XalgoPipelinePlugin extends FracPipelinePlugin {
  public static readonly source = 'xalgo'
  public readonly name = XalgoPipelinePlugin.source

  protected readonly appId: bigint

  constructor(algorand: AlgorandClient, overrides?: Record<string, unknown>) {
    super(algorand, overrides)
    let appId = XALGO_APP_ID_MAINNET
    if (overrides && 'appId' in overrides) {
      const override = overrides.appId
      const isPositiveInt =
        (typeof override === 'bigint' && override > 0n) ||
        (typeof override === 'number' && Number.isSafeInteger(override) && override > 0)
      if (!isPositiveInt) throw new Error(`xalgo: appId override must be a positive integer, got ${String(override)}`)
      appId = BigInt(override as number | bigint)
    }
    this.appId = appId
  }

  async init(): Promise<void> {}

  public async getInstanceNameFromEscrowAddrs(escrowAddrs: string[]): Promise<FracInstanceNameResultMap> {
    const xalgoEscrows = new Set(await this.getAllXalgoEscrowAddrs())
    const result: FracInstanceNameResultMap = {}
    // escrows that are not xALGO escrows belong to another source, so they are left out of the map
    for (const addr of escrowAddrs) {
      if (xalgoEscrows.has(addr)) result[addr] = XALGO_INSTANCE_NAME
    }
    return result
  }

  /**
   *
   * @returns escrow addresses, sorted
   */
  protected async getAllXalgoEscrowAddrs(): Promise<string[]> {
    // the escrows are the proposers, one `ap`-prefixed box each, with the address in the box *name*
    const boxNames = await this.algorand.app.getBoxNames(this.appId)
    const escrows = boxNames
      .filter(({ nameRaw }) => isProposerBox(nameRaw))
      .map(({ nameRaw }) => encodeAddress(nameRaw.slice(PROPOSER_BOX_PREFIX.length)))
      // stable escrow order across runs - algod returns box names in no guaranteed order
      .sort()
    // the app keeps other boxes too, so an empty result means the wrong app id rather than no proposers
    if (!escrows.length) throw new Error(`xalgo: app ${this.appId} exposes no proposer boxes`)
    // box listings are paginated, so cross-check against the count the app itself keeps: a short read
    // would otherwise silently drop escrows from the committee analysis
    const numProposers = (await this.algorand.app.getGlobalState(this.appId)).num_proposers?.value
    if (typeof numProposers !== 'bigint') throw new Error(`xalgo: app ${this.appId} exposes no num_proposers global`)
    if (numProposers !== BigInt(escrows.length)) {
      throw new Error(`xalgo: found ${escrows.length} proposer boxes but num_proposers is ${numProposers}`)
    }
    return escrows
  }

  public async calculateCommitteeAQ<T>(_committee: AQCommittee, _internalId?: T): Promise<AQResultMap> {
    // TODO implement
    return {}
  }
}

const isProposerBox = (nameRaw: Uint8Array): boolean =>
  nameRaw.length === PROPOSER_BOX_NAME_LENGTH && PROPOSER_BOX_PREFIX.every((byte, i) => nameRaw[i] === byte)
