import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { type Indexer, getApplicationAddress } from 'algosdk'
import { RetiGhostSDK } from 'reti-ghost-sdk'

import { existsSync } from 'node:fs'

import { MAX_WINDOW, assertAlgoQuartersFitUint32, checkOrCreateSnapshots } from '../../aq/index.ts'
import {
  FracPipelinePlugin,
  type AQCalculation,
  type AQCommittee,
  type AQResultMap,
  type FracInstanceName,
  type FracInstanceNameResultMap,
} from '../base.ts'
import {
  computeRetiMicroAlgoRounds,
  sumMicroAlgoRounds,
  toAlgoQuarters,
  type MicroAlgoRoundsByPool,
} from './compute.ts'
import { PROTOCOL, RETI_REGISTRY_APP_ID_MAINNET } from './constants.ts'
import { fetchRetiEvents } from './indexer.ts'
import { applyRetiEvent } from './ledger.ts'
import { buildSnapshot, createRetiSnapshotStore, deserializePools, type RetiSnapshotStore } from './snapshot.ts'
import { verifyAgainstChain } from './verify.ts'
import type { FinalInstance } from '../../types.ts'
import type { PoolLedger, RetiSnapshotData } from './types.ts'

// Selective on purpose: `export *` would collide with tALGO's and xALGO's `PROTOCOL` in the plugin
// registry's re-exports. Everything else is importable from './constants.ts'.
export { RETI_APP_CREATION_ROUND, RETI_APP_ID, RETI_REGISTRY_APP_ID_MAINNET } from './constants.ts'

/** A reti pool escrow: which validator runs it, and the staking pool app the ALGO sits in. */
interface RetiEscrow {
  validatorId: number
  poolAppId: bigint
}

/**
 * Réti open pooling: one frac instance per **validator**, named `Reti #<validatorId>`, whose escrows
 * are that validator's staking pool app accounts.
 *
 * The only multi-instance source. One committee can imply dozens of instances, so AQ is computed
 * with a single registry-wide scan of the window and then sliced: a staker earns AQ on an instance
 * for the stake it held in *that instance's committee pools*, and nothing for stake sitting in the
 * same validator's pools that are not in the committee — that stake backs none of the votes the
 * instance casts.
 */
export class RetiPipelinePlugin extends FracPipelinePlugin {
  public static readonly source = 'reti'
  public readonly name = RetiPipelinePlugin.source
  /** Protocol identifier stamped on every AQ manifest this plugin produces. */
  public readonly protocol = PROTOCOL

  protected retiSdk: RetiGhostSDK
  /** ValidatorRegistry the escrows are discovered from and the event stream is scanned on. */
  protected readonly registryAppId: bigint
  /** Snapshot persistence, bound to `overrides.snapshotsDir` or the packaged default. */
  protected readonly snapshots: RetiSnapshotStore

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
    this.registryAppId = BigInt(registryAppId)
    this.retiSdk = new RetiGhostSDK({ algorand, registryAppId })

    let snapshotsDir: string | undefined
    if (overrides && 'snapshotsDir' in overrides) {
      const override = overrides.snapshotsDir
      if (typeof override !== 'string' || !override) {
        throw new Error(`reti: snapshotsDir override must be a non-empty string, got ${String(override)}`)
      }
      snapshotsDir = override
    }
    this.snapshots = createRetiSnapshotStore(snapshotsDir)
  }

  async init(): Promise<void> {}

  /**
   * The Indexer the AQ history is read from: the client this plugin was constructed with, which is
   * the pipeline's discovery client. That may point at mainnet while the contracts being written
   * to live on localnet — the whole reason discovery is a separate client.
   */
  protected get indexer(): Indexer {
    return this.algorand.client.indexer
  }

  public async getInstanceNameFromEscrowAddrs(escrowAddrs: string[]): Promise<FracInstanceNameResultMap> {
    const escrowsByAddress = await this.getAllRetiEscrowAddrs()
    const result: FracInstanceNameResultMap = {}
    for (const addr of escrowAddrs) {
      const escrow = escrowsByAddress.get(addr)
      // escrowAddrs will typically be all committee members; only return reti pool escrows
      if (escrow !== undefined) result[addr] = instanceNameOf(escrow.validatorId)
    }
    return result
  }

  /**
   * Internal, returns every reti pool escrow with the validator that runs it and the pool app the
   * stake sits in. Resolves instance names from escrows, and escrows back to the pools whose events
   * an instance's AlgoQuarters are accrued from.
   * @returns map of reti pool app escrow address to its validator id and pool app id
   */
  protected async getAllRetiEscrowAddrs(): Promise<Map<string, RetiEscrow>> {
    // validator IDs are 1-based and contiguous, so the full set is derivable from the count
    const numValidators = await this.retiSdk.getNumValidators()
    const validatorIds = new Array(numValidators).fill(0).map((_, i) => i + 1)
    // getPools preserves input order, so pool lists line up with validatorIds by index
    const poolsPerValidator = await this.retiSdk.getPools(validatorIds)
    const escrows = new Map<string, RetiEscrow>()
    poolsPerValidator.forEach((pools, i) => {
      for (const pool of pools) {
        escrows.set(getApplicationAddress(pool.poolAppId).toString(), {
          validatorId: validatorIds[i],
          poolAppId: BigInt(pool.poolAppId),
        })
      }
    })
    return escrows
  }

  /**
   * Round-weighted AlgoQuarters for every staker of every given instance, over the committee's
   * window.
   *
   * One scan for all of them: the ValidatorRegistry logs every balance change in the protocol, so
   * the window is scanned once, replayed once, and the resulting per-pool accrual is sliced per
   * instance. Two instances of the same committee therefore cost exactly one Indexer pass.
   *
   * Each instance is scoped to its **own committee pools** — `instance.escrowAddresses` resolved
   * back to pool app ids — and each staker's microALGO-rounds are summed over just those pools and
   * floored once. A staker in two validators' pools earns on both instances, independently.
   *
   * Snapshots are the exception to "computes in memory", and deliberately so: the replay verifies
   * or writes one at every 1M-round boundary inside the window. That is both the cross-run
   * correctness check (a stored snapshot disagreeing with a fresh replay throws before anything is
   * returned) and what makes the next committee's window cheap.
   */
  public async calculateCommitteeAQ(
    committee: AQCommittee,
    instances: FinalInstance[],
  ): Promise<Map<FracInstanceName, AQCalculation>> {
    const periodStart = BigInt(committee.periodStart)
    const periodEnd = BigInt(committee.periodEnd)
    if (periodEnd <= periodStart) {
      throw new Error(`reti: periodEnd ${periodEnd} must be greater than periodStart ${periodStart}`)
    }
    if (periodEnd - periodStart > MAX_WINDOW) {
      throw new Error(
        `reti: window of ${periodEnd - periodStart} rounds exceeds the ${MAX_WINDOW} maximum — wrong committee?`,
      )
    }
    await this.assertWindowIsClosed(periodEnd)

    // Escrow to pool app id, from the same live registry read that minted the instance names in
    // stage 1 — so the plugin and the pipeline can never disagree about which pools an instance holds
    const escrowsByAddress = await this.getAllRetiEscrowAddrs()
    const poolsByInstance = new Map<FracInstanceName, bigint[]>()
    for (const instance of instances) {
      poolsByInstance.set(
        instance.name,
        instance.escrowAddresses.map((address) => {
          const escrow = escrowsByAddress.get(address)
          // Fail loud: an unrecognized escrow means the instance holds something that is not a reti
          // pool, and silently dropping it would quietly under-credit every staker in it
          if (!escrow) throw new Error(`reti: escrow ${address} of ${instance.name} is not a reti pool`)
          return escrow.poolAppId
        }),
      )
    }

    const { microAlgoRounds } = await this.replayWindow(periodStart, periodEnd)

    const results = new Map<FracInstanceName, AQCalculation>()
    for (const [instanceName, poolAppIds] of poolsByInstance) {
      results.set(instanceName, {
        protocol: this.protocol,
        accounts: this.toAccounts(microAlgoRounds, poolAppIds),
      })
    }
    return results
  }

  /**
   * Protocol-wide AlgoQuarters for a window: every pool of every validator, floored once per
   * staker. The unsliced path — what the retired `algoquarters:reti` CLI wrote, and what the
   * archived manifests are the regression check against (`pnpm verify-reti-aq`).
   */
  public async calculateWholeProtocolAQ(periodStart: number, periodEnd: number): Promise<AQCalculation> {
    await this.assertWindowIsClosed(BigInt(periodEnd))
    const { microAlgoRounds } = await this.replayWindow(BigInt(periodStart), BigInt(periodEnd))
    return { protocol: this.protocol, accounts: this.toAccounts(microAlgoRounds) }
  }

  /**
   * Rebuild the pool ledger at `round` from the registry's whole event stream and persist the
   * snapshot. The cold path — a full history scan — so it only runs when no snapshot for that
   * round is on disk.
   * @returns the snapshot, as written
   */
  public async buildSnapshot(round: bigint): Promise<RetiSnapshotData> {
    console.log(`[reti] no snapshot at round ${round}, rebuilding from registry creation — this takes a while`)
    const snapshot = await buildSnapshot(this.indexer, this.registryAppId, round)
    console.log(`  [reti] snapshot saved: ${this.snapshots.writeSnapshot(snapshot)}`)
    return snapshot
  }

  /**
   * Replay from the newest committed snapshot to the current round and diff every pool's stakers
   * against its live `stakers` box.
   * @throws if the replay and the chain disagree
   */
  public async verifyAgainstChain(): Promise<void> {
    await verifyAgainstChain(this.indexer, this.registryAppId, this.snapshots)
  }

  /**
   * Every round of the window has to be on chain. A window still open would be replayed as far as
   * the chain goes, and its boundary snapshots written with state that is not final — poisoning the
   * committed chain every later window starts from.
   */
  private async assertWindowIsClosed(periodEnd: bigint): Promise<void> {
    const { lastRound } = await this.algorand.client.algod.status().do()
    if (periodEnd - 1n > lastRound) {
      throw new Error(`reti: window ending at ${periodEnd} is not over yet — the chain is at round ${lastRound}`)
    }
  }

  /**
   * Scan and replay one window: load the snapshot at `periodStart`, accrue every staker's
   * microALGO-rounds per pool, and verify or write the snapshots at the 1M-round boundaries inside
   * the window. Shared by the sliced and whole-protocol paths, which differ only in how they floor.
   */
  private async replayWindow(
    periodStart: bigint,
    periodEnd: bigint,
  ): Promise<{ microAlgoRounds: MicroAlgoRoundsByPool }> {
    const pools = deserializePools(await this.readOrBuildSnapshot(periodStart))
    console.log(`[reti] window [${periodStart}, ${periodEnd}) from a snapshot of ${pools.size} pools`)

    const { events, epochRoundLengths } = await fetchRetiEvents(
      this.indexer,
      this.registryAppId,
      periodStart,
      periodEnd,
    )
    const poolCount = new Set(events.map((event) => event.poolAppId)).size
    console.log(
      `  [reti] ${events.length} events in the window, from ${epochRoundLengths.size} validators and ${poolCount} pools`,
    )

    // computeRetiMicroAlgoRounds mutates the ledger as it replays, so the snapshot chaining below
    // needs its own copy of where the window started
    const snapshotPools = clonePools(pools)
    const microAlgoRounds = computeRetiMicroAlgoRounds(
      pools,
      events,
      epochRoundLengths,
      Number(periodStart),
      Number(periodEnd),
    )

    // Verify-first: a stored snapshot that disagrees with this replay throws, and nothing is written
    const pendingSnapshots = checkOrCreateSnapshots(
      this.snapshots,
      snapshotPools,
      events,
      (ledger, event) => applyRetiEvent(ledger, event, epochRoundLengths),
      periodStart,
      periodEnd,
    )
    for (const pending of pendingSnapshots) {
      console.log(`  [reti] snapshot saved: ${this.snapshots.writeSnapshot(pending)}`)
    }

    return { microAlgoRounds }
  }

  /**
   * Floor one pool set's accrual to the manifest's account map.
   *
   * No exclusion list is needed: pool escrows hold the ALGO but never appear as stakers, and
   * validator commission is paid out directly. The unit is the eligibility cutoff, so stakers
   * flooring below 1 AQ are omitted.
   * @param poolAppIds pools to credit; omit for every pool in the accrual
   */
  private toAccounts(microAlgoRounds: MicroAlgoRoundsByPool, poolAppIds?: bigint[]): AQResultMap {
    const accounts: AQResultMap = {}
    for (const [staker, aq] of toAlgoQuarters(sumMicroAlgoRounds(microAlgoRounds, poolAppIds))) {
      if (aq <= 0n) continue
      assertAlgoQuartersFitUint32(aq, staker)
      accounts[staker] = Number(aq)
    }
    return accounts
  }

  /** The snapshot at `round`, rebuilt from chain history when it is not on disk. */
  private async readOrBuildSnapshot(round: bigint): Promise<RetiSnapshotData> {
    // Existence, not try/catch: a snapshot that is present but unreadable is a problem to surface,
    // not a reason to spend an hour rebuilding it.
    if (!existsSync(this.snapshots.getSnapshotPath(round))) return this.buildSnapshot(round)
    return this.snapshots.readSnapshot(round)
  }
}

/** The on-chain instance name this plugin mints for a validator. */
function instanceNameOf(validatorId: number): FracInstanceName {
  return `Reti #${validatorId}`
}

function clonePools(pools: PoolLedger): PoolLedger {
  return new Map([...pools].map(([poolAppId, stakers]) => [poolAppId, new Map(stakers)]))
}
