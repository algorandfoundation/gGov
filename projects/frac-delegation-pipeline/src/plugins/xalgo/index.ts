import type { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { type Indexer, encodeAddress } from 'algosdk'

import { existsSync } from 'node:fs'

import {
  MAX_WINDOW,
  assertAlgoQuartersFitUint32,
  checkOrCreateSnapshots,
  scanAssetTransfers,
  type AssetTransfer,
} from '../../aq/index.ts'
import {
  FracPipelinePlugin,
  type AQCalculation,
  type AQCommittee,
  type AQResultMap,
  type FracInstanceName,
  type FracInstanceNameResultMap,
} from '../base.ts'
import { createBeneficiaryStore, resolveBeneficiaries, type BeneficiaryStore } from './beneficiaries.ts'
import { computeAttribution, mergeAssetTransfers, toAlgoQuarters } from './compute.ts'
import {
  FXALGO_ASA_ID,
  PROPOSER_BOX_NAME_LENGTH,
  PROPOSER_BOX_PREFIX,
  PROTOCOL,
  RATE_SCALER,
  XALGO_APP_ID_MAINNET,
  XALGO_ASA_ID,
  XALGO_INSTANCE_NAME,
} from './constants.ts'
import { isExcluded } from './exclusions.ts'
import { fetchXAlgoRateInRange } from './indexer.ts'
import { applyTransfer } from './ledger.ts'
import { buildSnapshot, createXalgoSnapshotStore, getAllSnapshotBalances, type XalgoSnapshotStore } from './snapshot.ts'
import { checkLargeHolders, logSnapshotStats } from './stats.ts'
import type { FinalInstance } from '../../types.ts'
import type { BalanceMap, SnapshotData } from './types.ts'
import { verifyAgainstChain } from './verify.ts'

// Selective on purpose: `export *` would collide with tALGO's `PROTOCOL`/`RATE_SCALER` in the plugin
// registry's re-exports. Everything else is importable from './constants.ts'.
export {
  FXALGO_ASA_ID,
  XALGO_APP_ID_MAINNET,
  XALGO_ASA_ID,
  XALGO_INSTANCE_NAME,
  XALGO_POOL_APP_ID,
} from './constants.ts'

const RATE_DECIMAL_PLACES = RATE_SCALER.toString().length - 1

/** Render the 1e12-scaled rate as the fixed-point decimal string the AQ manifest carries. */
function formatRate(rate: bigint): string {
  const integer = rate / RATE_SCALER
  const fraction = (rate % RATE_SCALER).toString().padStart(RATE_DECIMAL_PLACES, '0')
  return `${integer}.${fraction}`
}

/**
 * Folks Finance xALGO: a single liquid-staking instance whose escrows are the consensus app's
 * proposers. Stage 1 recognizes them; stage 3 computes AlgoQuarters for xALGO's beneficial holders —
 * direct holders, and the Folks lending pool's xALGO seen through to fxALGO holders and their escrow
 * owners. Methodology in README.md.
 */
export class XalgoPipelinePlugin extends FracPipelinePlugin {
  public static readonly source = 'xalgo'
  public readonly name = XalgoPipelinePlugin.source
  /** Protocol identifier stamped on every AQ manifest this plugin produces. */
  public readonly protocol = PROTOCOL

  protected readonly appId: bigint
  /** Snapshot persistence, bound to `overrides.snapshotsDir` or the packaged default. */
  protected readonly snapshots: XalgoSnapshotStore
  /** The escrow → owner resolution cache, next to the snapshots. */
  protected readonly beneficiaries: BeneficiaryStore
  /** Downgrade the >40%-of-supply holder check from a throw to a warning. */
  protected readonly allowLargeHolders: boolean

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

    let snapshotsDir: string | undefined
    if (overrides && 'snapshotsDir' in overrides) {
      const override = overrides.snapshotsDir
      if (typeof override !== 'string' || !override) {
        throw new Error(`xalgo: snapshotsDir override must be a non-empty string, got ${String(override)}`)
      }
      snapshotsDir = override
    }
    this.snapshots = createXalgoSnapshotStore(snapshotsDir)
    this.beneficiaries = createBeneficiaryStore(this.snapshots.beneficiariesPath)
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
    return fetchXalgoProposerAddrs(this.algorand, this.appId)
  }

  /**
   * Round-weighted AlgoQuarters for every xALGO beneficiary over the committee's window: direct
   * holders, plus the Folks lending pool's xALGO seen through to fxALGO holders and their escrow
   * owners (README.md).
   *
   * Loads the balance snapshot at `periodStart` (building it from asset creation if it is missing),
   * replays every xALGO and fxALGO transfer in `[periodStart, periodEnd)`, resolves the fxALGO
   * holders it meets to their beneficiaries, and converts the accrued µxALGO·rounds to integer AQ at
   * the window's fixed xALGO/ALGO rate. Computed in memory: no manifest file is read or written, the
   * caller ingests the result directly.
   *
   * Snapshots and the beneficiary cache are the exception, and deliberately so — the replay verifies
   * or writes a snapshot at every 1M-round boundary inside the window (a stored snapshot disagreeing
   * with a fresh replay throws before anything is returned), and every newly resolved escrow owner
   * is persisted, so the next committee's window starts from what this run produced.
   *
   * `instances` is unused: xALGO is a single instance, so the pipeline can only ever pass the one,
   * and the result is the single-entry map keyed by `XALGO_INSTANCE_NAME`.
   */
  public async calculateCommitteeAQ(
    committee: AQCommittee,
    _instances: FinalInstance[],
  ): Promise<Map<FracInstanceName, AQCalculation>> {
    const periodStart = BigInt(committee.periodStart)
    const periodEnd = BigInt(committee.periodEnd)
    if (periodEnd <= periodStart) {
      throw new Error(`xalgo: periodEnd ${periodEnd} must be greater than periodStart ${periodStart}`)
    }
    if (periodEnd - periodStart > MAX_WINDOW) {
      throw new Error(
        `xalgo: window of ${periodEnd - periodStart} rounds exceeds the ${MAX_WINDOW} maximum — wrong committee?`,
      )
    }

    // Every round of the window has to be on chain: a window still open would be replayed as far as
    // the chain goes and its boundary snapshots written with state that is not final
    const { lastRound } = await this.algorand.client.algod.status().do()
    if (periodEnd - 1n > lastRound) {
      throw new Error(
        `xalgo: window [${periodStart}, ${periodEnd}) is not over yet — the chain is at round ${lastRound}`,
      )
    }

    const snapshot = await this.readOrBuildSnapshot(periodStart)
    const balances = getAllSnapshotBalances(snapshot)

    const xAlgoTransfers: AssetTransfer[] = []
    const fxAlgoTransfers: AssetTransfer[] = []
    await this.scanWindow(XALGO_ASA_ID, periodStart, periodEnd, xAlgoTransfers, 'xALGO')
    await this.scanWindow(FXALGO_ASA_ID, periodStart, periodEnd, fxAlgoTransfers, 'fxALGO')
    const transfers = mergeAssetTransfers(xAlgoTransfers, fxAlgoTransfers)

    // Whoever holds fxALGO at any point of the window held it at the start or received it inside:
    // those are the addresses whose beneficiary matters. Resolved once, cached for every later window.
    const beneficiaries = this.beneficiaries.readMap()
    const candidates = new Set<string>()
    for (const [address, balance] of balances) if (balance.fxalgo > 0n) candidates.add(address)
    for (const transfer of fxAlgoTransfers) {
      candidates.add(transfer.receiver)
      if (transfer.closeTo) candidates.add(transfer.closeTo)
    }
    const { added, warnings } = await resolveBeneficiaries(this.indexer, candidates, beneficiaries)
    console.log(`  [xalgo] ${candidates.size} fxALGO holders in the window, ${added.length} newly resolved`)
    for (const warning of warnings) console.warn(`  [xalgo] ⚠ ${warning}`)

    const observed = await fetchXAlgoRateInRange(this.indexer, this.appId, periodStart, periodEnd)
    if (observed === null) {
      throw new Error(`xalgo: no ImmediateMint/Burn/ClaimDelayedMint event found in [${periodStart}, ${periodEnd})`)
    }
    console.log(`  [xalgo] rate ${formatRate(observed.rate)} from ${observed.event.kind} at round ${observed.round}`)
    if (observed.event.kind === 'ImmediateMint') await this.warnIfPremium()

    // computeAttribution mutates the balances as it replays, so the snapshot chaining below needs
    // its own copy of where the window started
    const snapshotBalances = cloneBalances(balances)
    const attribution = computeAttribution(balances, transfers, Number(periodStart), Number(periodEnd), beneficiaries)
    if (attribution.unattributed > 0n) {
      console.warn(
        `  [xalgo] ⚠ pool xALGO accrued with no fxALGO in circulation (unattributed): ${attribution.unattributed}`,
      )
    }
    const algoQuarters = toAlgoQuarters(attribution.byBeneficiary, observed.rate)

    // The unit is the eligibility cutoff: accounts flooring below 1 AQ are omitted
    const accounts: AQResultMap = {}
    for (const [address, aq] of algoQuarters) {
      if (isExcluded(address) || aq <= 0n) continue
      assertAlgoQuartersFitUint32(aq, address)
      accounts[address] = Number(aq)
    }

    // Verify-first: a stored snapshot that disagrees with this replay throws, and nothing is written
    const pendingSnapshots = checkOrCreateSnapshots(
      this.snapshots,
      snapshotBalances,
      transfers,
      (balances, transfer) => applyTransfer(balances, transfer, transfer.asset),
      periodStart,
      periodEnd,
    )
    for (const pending of pendingSnapshots) {
      console.log(`  [xalgo] snapshot saved: ${this.snapshots.writeSnapshot(pending)}`)
    }
    if (added.length > 0) {
      console.log(
        `  [xalgo] beneficiaries saved: ${this.beneficiaries.write(this.beneficiaries.fromMap(beneficiaries))}`,
      )
    }

    return new Map([[XALGO_INSTANCE_NAME, { protocol: this.protocol, rate: formatRate(observed.rate), accounts }]])
  }

  /**
   * Rebuild balances at `round` from asset creation and persist the snapshot. The cold path — a
   * full history scan — so it only runs when no snapshot for that round is on disk.
   * @returns the snapshot, as written
   */
  public async buildSnapshot(round: bigint): Promise<SnapshotData> {
    console.log(`[xalgo] no snapshot at round ${round}, rebuilding from asset creation — this takes a while`)
    const snapshot = await buildSnapshot(this.indexer, round)
    logSnapshotStats(snapshot, this.beneficiaries.readMap())
    console.log(`  [xalgo] snapshot saved: ${this.snapshots.writeSnapshot(snapshot)}`)
    // After writing, so a flagged snapshot is still on disk to inspect
    this.checkLargeHolders(snapshot)
    return snapshot
  }

  /**
   * Replay from the newest committed snapshot to the current round and diff every holder's balance
   * against the chain; cross-check the beneficiary cache against live escrow local state.
   * @throws if the replay and the chain disagree
   */
  public async verifyAgainstChain(): Promise<void> {
    await verifyAgainstChain(this.indexer, this.snapshots, this.beneficiaries.readMap())
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

  /**
   * An `ImmediateMint` rate embeds the consensus app's `premium` (overstating the rate by
   * 1/(1 − premium)); it is 0 today and capped at 1%, so a non-zero live value is worth a warning.
   */
  private async warnIfPremium(): Promise<void> {
    const premium = (await this.algorand.app.getGlobalState(this.appId)).premium?.value
    if (typeof premium === 'bigint' && premium !== 0n) {
      console.warn(
        `  [xalgo] ⚠ rate read from an ImmediateMint while premium is ${premium} (16 dp): overstated by up to that much`,
      )
    }
  }

  private checkLargeHolders(snapshot: SnapshotData): void {
    if (!this.allowLargeHolders) return checkLargeHolders(snapshot)
    try {
      checkLargeHolders(snapshot)
    } catch (err) {
      console.warn(`[xalgo] ${err instanceof Error ? err.message : err}`)
    }
  }
}

function cloneBalances(balances: BalanceMap): BalanceMap {
  return new Map([...balances].map(([address, balance]) => [address, { xalgo: balance.xalgo, fxalgo: balance.fxalgo }]))
}

const isProposerBox = (nameRaw: Uint8Array): boolean =>
  nameRaw.length === PROPOSER_BOX_NAME_LENGTH && PROPOSER_BOX_PREFIX.every((byte, i) => nameRaw[i] === byte)

/**
 * The consensus app's proposers — its escrows on the gGov side — one `ap`-prefixed box each, with
 * the address in the box *name*. Exported for the seeding scripts, which pick escrows off mainnet.
 * @returns escrow addresses, sorted
 */
export async function fetchXalgoProposerAddrs(algorand: AlgorandClient, appId: bigint): Promise<string[]> {
  const boxNames = await algorand.app.getBoxNames(appId)
  const escrows = boxNames
    .filter(({ nameRaw }) => isProposerBox(nameRaw))
    .map(({ nameRaw }) => encodeAddress(nameRaw.slice(PROPOSER_BOX_PREFIX.length)))
    // stable escrow order across runs - algod returns box names in no guaranteed order
    .sort()
  // the app keeps other boxes too, so an empty result means the wrong app id rather than no proposers
  if (!escrows.length) throw new Error(`xalgo: app ${appId} exposes no proposer boxes`)
  // box listings are paginated, so cross-check against the count the app itself keeps: a short read
  // would otherwise silently drop escrows from the committee analysis
  const numProposers = (await algorand.app.getGlobalState(appId)).num_proposers?.value
  if (typeof numProposers !== 'bigint') throw new Error(`xalgo: app ${appId} exposes no num_proposers global`)
  if (numProposers !== BigInt(escrows.length)) {
    throw new Error(`xalgo: found ${escrows.length} proposer boxes but num_proposers is ${numProposers}`)
  }
  return escrows
}
