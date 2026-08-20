import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { type Indexer, encodeAddress, getApplicationAddress } from 'algosdk'

import { existsSync } from 'node:fs'

import { MAX_WINDOW, assertAlgoQuartersFitUint32, createSnapshotChain, scanAssetTransfers } from '../../aq/index.ts'
import {
  FracPipelinePlugin,
  type AQCalculation,
  type AQCommittee,
  type AQResultMap,
  type FracInstanceName,
  type FracInstanceNameResultMap,
} from '../base.ts'
import { computeAlgoQuarters, mergeAssetTransfers } from './compute.ts'
import {
  PROTOCOL,
  RATE_SCALER,
  STALGO_ASA_ID,
  TALGO_APP_ID_MAINNET,
  TALGO_ASA_ID,
  TALGO_INSTANCE_NAME,
} from './constants.ts'
import { isExcluded } from './exclusions.ts'
import { fetchTAlgoRateInRange } from './indexer.ts'
import { buildSnapshot, createTalgoSnapshotStore, getAllSnapshotBalances, type TalgoSnapshotStore } from './snapshot.ts'
import { checkLargeHolders, logSnapshotStats } from './stats.ts'
import { verifyAgainstChain } from './verify.ts'
import type { FinalInstance } from '../../types.ts'
import type { AssetTransfer } from '../../aq/index.ts'
import type { SnapshotData } from './types.ts'

export * from './constants.ts'

const RATE_DECIMAL_PLACES = RATE_SCALER.toString().length - 1

/** Render the 1e12-scaled rate as the fixed-point decimal string the AQ manifest carries. */
function formatRate(rate: bigint): string {
  const integer = rate / RATE_SCALER
  const fraction = (rate % RATE_SCALER).toString().padStart(RATE_DECIMAL_PLACES, '0')
  return `${integer}.${fraction}`
}

export class TalgoPipelinePlugin extends FracPipelinePlugin {
  public static readonly source = 'talgo'
  public readonly name = TalgoPipelinePlugin.source
  /** Protocol identifier stamped on every AQ manifest this plugin produces. */
  public readonly protocol = PROTOCOL

  protected readonly appId: bigint
  protected readonly appAddress: string
  /** Snapshot persistence, bound to `overrides.snapshotsDir` or the packaged default. */
  protected readonly snapshots: TalgoSnapshotStore
  /** Downgrade the >40%-of-supply holder check from a throw to a warning. */
  protected readonly allowLargeHolders: boolean

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

    let snapshotsDir: string | undefined
    if (overrides && 'snapshotsDir' in overrides) {
      const override = overrides.snapshotsDir
      if (typeof override !== 'string' || !override) {
        throw new Error(`talgo: snapshotsDir override must be a non-empty string, got ${String(override)}`)
      }
      snapshotsDir = override
    }
    this.snapshots = createTalgoSnapshotStore(snapshotsDir)
    this.allowLargeHolders = overrides?.allowLargeHolders === true
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

  /**
   * Round-weighted AlgoQuarters for every eligible tALGO/stALGO holder over the committee's window.
   *
   * Loads the balance snapshot at `periodStart` (building it from asset creation if it is missing),
   * replays every transfer in `[periodStart, periodEnd)`, and converts the accrued microALGO-rounds
   * to integer AQ at the window's fixed tALGO/ALGO rate. Computed in memory: no manifest file is
   * read or written, the caller ingests the result directly.
   *
   * Snapshots are the exception, and deliberately so — the replay verifies or writes one at every
   * 1M-round boundary inside the window. That is both the cross-run correctness check (a stored
   * snapshot disagreeing with a fresh replay throws before anything is returned) and what makes the
   * next committee's window cheap, since its `periodStart` snapshot is one this run just produced.
   *
   * `instances` is unused: tALGO is a single instance, so the pipeline can only ever pass the one,
   * and the result is the single-entry map keyed by `TALGO_INSTANCE_NAME`.
   */
  public async calculateCommitteeAQ(
    committee: AQCommittee,
    _instances: FinalInstance[],
  ): Promise<Map<FracInstanceName, AQCalculation>> {
    const periodStart = BigInt(committee.periodStart)
    const periodEnd = BigInt(committee.periodEnd)
    if (periodEnd <= periodStart) {
      throw new Error(`talgo: periodEnd ${periodEnd} must be greater than periodStart ${periodStart}`)
    }
    if (periodEnd - periodStart > MAX_WINDOW) {
      throw new Error(
        `talgo: window of ${periodEnd - periodStart} rounds exceeds the ${MAX_WINDOW} maximum — wrong committee?`,
      )
    }

    const snapshot = await this.readOrBuildSnapshot(periodStart)
    const balances = getAllSnapshotBalances(snapshot)

    const tAlgoRate = await fetchTAlgoRateInRange(this.indexer, this.appId, periodStart, periodEnd)
    if (tAlgoRate === null) throw new Error(`talgo: no rate_update event found in [${periodStart}, ${periodEnd})`)

    const tAlgoTransfers: AssetTransfer[] = []
    const stAlgoTransfers: AssetTransfer[] = []
    // Two independent scans collecting into their own arrays, merged below — so they overlap
    await Promise.all([
      this.scanWindow(TALGO_ASA_ID, periodStart, periodEnd, tAlgoTransfers, 'tALGO'),
      this.scanWindow(STALGO_ASA_ID, periodStart, periodEnd, stAlgoTransfers, 'stALGO'),
    ])

    // The replay below passes through the state of every 1M-round boundary in the window, so the
    // snapshots are captured off it rather than replaying the transfers a second time over a copy
    const transfers = mergeAssetTransfers(tAlgoTransfers, stAlgoTransfers)
    const snapshots = createSnapshotChain(this.snapshots, balances, periodStart, periodEnd)
    const algoQuartersByAddress = computeAlgoQuarters(
      balances,
      transfers,
      Number(periodStart),
      Number(periodEnd),
      tAlgoRate,
      snapshots.recorder,
    )

    // The unit is the eligibility cutoff: accounts flooring below 1 AQ are omitted
    const accounts: AQResultMap = {}
    for (const [address, aq] of algoQuartersByAddress) {
      if (isExcluded(address) || aq <= 0n) continue
      assertAlgoQuartersFitUint32(aq, address)
      accounts[address] = Number(aq)
    }

    // Verify-first: a stored snapshot that disagrees with this replay throws, and nothing is written
    const pendingSnapshots = snapshots.verify()
    for (const pending of pendingSnapshots) {
      console.log(`  [talgo] snapshot saved: ${this.snapshots.writeSnapshot(pending)}`)
    }

    return new Map([[TALGO_INSTANCE_NAME, { protocol: this.protocol, rate: formatRate(tAlgoRate), accounts }]])
  }

  /**
   * Rebuild balances at `round` from asset creation and persist the snapshot. The cold path — a
   * full history scan — so it only runs when no snapshot for that round is on disk.
   * @returns the snapshot, as written
   */
  public async buildSnapshot(round: bigint): Promise<SnapshotData> {
    console.log(`[talgo] no snapshot at round ${round}, rebuilding from asset creation — this takes a while`)
    const snapshot = await buildSnapshot(this.indexer, round)
    logSnapshotStats(snapshot)
    console.log(`  [talgo] snapshot saved: ${this.snapshots.writeSnapshot(snapshot)}`)
    // After writing, so a flagged snapshot is still on disk to inspect
    this.checkLargeHolders(snapshot)
    return snapshot
  }

  /**
   * Replay from the newest committed snapshot to the current round and diff every holder's balance
   * against the chain.
   * @throws if the replay and the chain disagree
   */
  public async verifyAgainstChain(): Promise<void> {
    await verifyAgainstChain(this.indexer, this.snapshots)
  }

  /** The snapshot at `round`, rebuilt from chain history when it is not on disk. */
  private async readOrBuildSnapshot(round: bigint): Promise<SnapshotData> {
    // Existence, not try/catch: a snapshot that is present but unreadable is a problem to surface,
    // not a reason to spend an hour rebuilding it.
    if (!existsSync(this.snapshots.getSnapshotPath(round))) return this.buildSnapshot(round)
    return this.snapshots.readSnapshot(round)
  }

  private async scanWindow(
    assetId: bigint,
    periodStart: bigint,
    periodEnd: bigint,
    into: AssetTransfer[],
    label: string,
  ): Promise<void> {
    await scanAssetTransfers(
      this.indexer,
      assetId,
      periodStart,
      periodEnd,
      (batch) => {
        for (const transfer of batch) into.push(transfer)
      },
      label,
    )
  }

  private checkLargeHolders(snapshot: SnapshotData): void {
    if (!this.allowLargeHolders) return checkLargeHolders(snapshot)
    try {
      checkLargeHolders(snapshot)
    } catch (err) {
      console.warn(`[talgo] ${err instanceof Error ? err.message : err}`)
    }
  }
}
