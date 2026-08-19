import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { getApplicationAddress } from 'algosdk'
import { RetiGhostSDK } from 'reti-ghost-sdk'
import { FracPipelinePlugin, type AQCalculation, type AQCommittee, type FracInstanceNameResultMap } from './base.ts'

export const RETI_REGISTRY_APP_ID_MAINNET = 2714516089

export class RetiPipelinePlugin extends FracPipelinePlugin {
  public static readonly source = 'reti'
  public readonly name = RetiPipelinePlugin.source

  protected retiSdk: RetiGhostSDK

  constructor(algorand: AlgorandClient, overrides?: Record<string, unknown>) {
    super(algorand, overrides)
    let registryAppId = RETI_REGISTRY_APP_ID_MAINNET
    if (overrides && 'registryAppId' in overrides) {
      const override = overrides.registryAppId
      if (typeof override !== 'number' || !Number.isSafeInteger(override) || override <= 0) {
        throw new Error(`reti: registryAppId override must be a positive integer, got ${String(override)}`)
      }
      registryAppId = override
    }
    this.retiSdk = new RetiGhostSDK({ algorand, registryAppId })
  }

  async init(): Promise<void> {}

  public async getInstanceNameFromEscrowAddrs(escrowAddrs: string[]): Promise<FracInstanceNameResultMap> {
    const validatorIdByEscrow = await this.getAllRetiEscrowAddrs()
    const result: FracInstanceNameResultMap = {}
    for (const addr of escrowAddrs) {
      const validatorId = validatorIdByEscrow.get(addr)
      // escrowAddrs will typically be all committee members; only return reti pool escrows
      if (validatorId !== undefined) {
        result[addr] = `Reti #${validatorId}`
      }
    }
    return result
  }

  /**
   * Internal, returns all Reti pool escrows and their validator IDs. Used to resolve instance names from escrows.
   * @returns map of reti pool app escrow address to reti *validator* ID
   */
  protected async getAllRetiEscrowAddrs(): Promise<Map<string, number>> {
    // validator IDs are 1-based and contiguous, so the full set is derivable from the count
    const numValidators = await this.retiSdk.getNumValidators()
    const validatorIds = new Array(numValidators).fill(0).map((_, i) => i + 1)
    // getPools preserves input order, so pool lists line up with validatorIds by index
    const poolsPerValidator = await this.retiSdk.getPools(validatorIds)
    const escrows = new Map<string, number>()
    poolsPerValidator.forEach((pools, i) => {
      for (const pool of pools) {
        escrows.set(getApplicationAddress(pool.poolAppId).toString(), validatorIds[i])
      }
    })
    return escrows
  }

  /** Reti's validator id, parsed back out of the instance name this plugin mints. */
  public override instanceInternalId(instanceName: string): number | undefined {
    const match = /^Reti #(\d+)$/.exec(instanceName)
    return match ? Number(match[1]) : undefined
  }

  public async calculateCommitteeAQ<T>(_committee: AQCommittee, _internalId?: T): Promise<AQCalculation> {
    // TODO implement — port `ggov-algoquarters/src/reti` the way `talgo` was ported.
    // An empty `accounts` map is how the pipeline recognizes a source with no AQ support yet.
    return { protocol: RetiPipelinePlugin.source, accounts: {} }
  }
}
