/**
 * Sync the LocalNet block clock to wall-clock time.
 *
 * In dev mode LocalNet mints one block per transaction, and a freshly minted block is stamped with
 * the node's current wall-clock time. When LocalNet has sat idle, `Global.latestTimestamp` is frozen
 * at the last block and lags real time; contracts that gate on `Global.latestTimestamp` (voting
 * windows, etc.) then disagree with tests that compute windows from `Date.now()`.
 *
 * Producing fresh blocks drags the chain clock *forward* to now, but block timestamps are
 * monotonic non-decreasing, so blocks can never move the clock *backward*. Hence:
 *   - chain BEHIND wall-clock  -> fixable by spamming txns (this script)
 *   - chain AHEAD of wall-clock -> not fixable; LocalNet must be reset.
 *
 * Chain ahead of wall clock is not a frequent concern, would normally only happen if
 * the host machine moved its clock backwards significantly after transacting on localnet.
 *
 * Reused by the vitest globalSetup and runnable manually:  pnpm --filter smart_contracts sync-clock
 */
import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/** Drift magnitude (seconds) at/under which we auto-sync; above this we hard-fail. */
export const LOCALNET_CLOCK_FAIL_THRESHOLD_S = 24 * 60 * 60 // 24 hours
/** Once within this many seconds of wall-clock, the chain is considered synced. */
export const LOCALNET_CLOCK_TOLERANCE_S = 20
/** Max seconds a single dev-mode block advances the chain clock; used to estimate blocks needed. */
const MAX_BLOCK_ADVANCE_S = 25
/** Safety cap on the polling tail (blocks minted while checking the timestamp after the estimate). */
const MAX_SYNC_POLL_BLOCKS = 30

const RESET_HINT = 'Reset LocalNet to fix:  algokit localnet reset'

export class LocalNetClockError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LocalNetClockError'
  }
}

export interface SyncClockOptions {
  /** Defaults to AlgorandClient.defaultLocalNet(). */
  algorand?: AlgorandClient
  toleranceS?: number
  failThresholdS?: number
  maxBlocks?: number
  log?: (message: string) => void
}

export interface SyncClockResult {
  /** What was done: nothing (already in tolerance), genesis left untouched, or blocks minted. */
  action: 'already-synced' | 'left-at-genesis' | 'synced'
  /** Drift (now - chainTs) before syncing. Positive = chain behind wall-clock. */
  initialDriftSeconds: number
  /** Drift after syncing. */
  finalDriftSeconds: number
  blocksProduced: number
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

async function getLatestBlock(algorand: AlgorandClient): Promise<{ round: bigint; timestamp: number }> {
  const { algod } = algorand.client
  const { lastRound } = await algod.status().do()
  const {
    block: {
      header: { timestamp },
    },
  } = await algod.block(lastRound).headerOnly(true).do()
  return { round: lastRound, timestamp: Number(timestamp) }
}

async function getLatestBlockTimestamp(algorand: AlgorandClient): Promise<number> {
  return (await getLatestBlock(algorand)).timestamp
}

function formatDrift(seconds: number): string {
  const abs = Math.abs(seconds)
  const dir = seconds >= 0 ? 'behind' : 'ahead of'
  const h = Math.floor(abs / 3600)
  const m = Math.floor((abs % 3600) / 60)
  const s = abs % 60
  const parts = [h && `${h}h`, m && `${m}m`, `${s}s`].filter(Boolean).join(' ')
  return `${parts} ${dir} wall-clock`
}

/**
 * Ensure the LocalNet chain clock is within tolerance of wall-clock, minting blocks if needed.
 * Throws {@link LocalNetClockError} when the drift is too large or cannot be corrected.
 */
export async function syncLocalNetClock(opts: SyncClockOptions = {}): Promise<SyncClockResult> {
  const algorand = opts.algorand ?? AlgorandClient.defaultLocalNet()
  const toleranceS = opts.toleranceS ?? LOCALNET_CLOCK_TOLERANCE_S
  const failThresholdS = opts.failThresholdS ?? LOCALNET_CLOCK_FAIL_THRESHOLD_S
  const maxBlocks = opts.maxBlocks ?? MAX_SYNC_POLL_BLOCKS
  const log = opts.log ?? (() => {})

  const latest = await getLatestBlock(algorand)
  let chainTs = latest.timestamp
  const initialDrift = nowSeconds() - chainTs

  // Already in sync.
  if (Math.abs(initialDrift) <= toleranceS) {
    return {
      action: 'already-synced',
      initialDriftSeconds: initialDrift,
      finalDriftSeconds: initialDrift,
      blocksProduced: 0,
    }
  }

  // A freshly reset LocalNet is at genesis (round 0, timestamp 0 ≈ 1970). Leave it untouched at
  // block 0 — the first real transaction will stamp its block with wall-clock time, so minting a
  // sync block here would only burn a round.
  if (latest.round === 0n) {
    return {
      action: 'left-at-genesis',
      initialDriftSeconds: initialDrift,
      finalDriftSeconds: initialDrift,
      blocksProduced: 0,
    }
  }

  // Too far gone to auto-correct.
  if (Math.abs(initialDrift) > failThresholdS) {
    throw new LocalNetClockError(
      `LocalNet clock is ${formatDrift(initialDrift)}, exceeding the ${failThresholdS}s (24h) auto-sync threshold.\n${RESET_HINT}`,
    )
  }

  // Chain is ahead of wall-clock beyond tolerance (within the threshold): blocks are monotonic,
  // so we cannot rewind.
  if (initialDrift < -toleranceS) {
    throw new LocalNetClockError(
      `LocalNet clock is ${formatDrift(initialDrift)}; producing blocks cannot move it backward.\n${RESET_HINT}`,
    )
  }

  // Chain is behind wall-clock: mint blocks (0-Algo self payments) until it catches up.
  const dispenser = await algorand.account.localNetDispenser()
  let blocksProduced = 0

  // Note = block index, the minimal value that keeps each self-payment's txid unique
  // (identical payments would otherwise collide: "transaction already in ledger").
  const mintBlock = async () => {
    await algorand.send.payment({
      sender: dispenser.addr,
      receiver: dispenser.addr,
      amount: (0).algos(),
      note: `${blocksProduced}`,
    })
    blocksProduced++
  }

  // Each block advances the clock by at most MAX_BLOCK_ADVANCE_S, so minting floor(drift / 25) blocks
  // is guaranteed to leave us still behind wall-clock — never overshooting into the un-rewindable
  // "ahead" state. Mint those without polling, then poll after each further block.
  const estimatedBlocks = Math.floor(initialDrift / MAX_BLOCK_ADVANCE_S)
  log(`LocalNet clock is ${formatDrift(initialDrift)}; syncing (~${estimatedBlocks + 1} blocks)...`)
  for (let i = 0; i < estimatedBlocks; i++) {
    await mintBlock()
  }

  for (let i = 0; i < maxBlocks; i++) {
    await mintBlock()
    chainTs = await getLatestBlockTimestamp(algorand)
    const drift = nowSeconds() - chainTs
    if (Math.abs(drift) <= toleranceS) {
      log(`Synced LocalNet clock in ${blocksProduced} block(s) (was ${formatDrift(initialDrift)}).`)
      return { action: 'synced', initialDriftSeconds: initialDrift, finalDriftSeconds: drift, blocksProduced }
    }
  }

  const finalDrift = nowSeconds() - chainTs
  throw new LocalNetClockError(
    `Failed to sync LocalNet clock after ${blocksProduced} blocks; still ${formatDrift(finalDrift)}. ` +
      `The node clock may be stuck (host suspended?).\n${RESET_HINT}`,
  )
}

// CLI entry: `tsx scripts/sync-localnet-clock.ts`
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (invokedDirectly) {
  syncLocalNetClock({ log: (m) => console.log(m) })
    .then((r) => {
      if (r.action === 'synced') {
        console.log(`Done. Final drift ${r.finalDriftSeconds}s after ${r.blocksProduced} block(s).`)
      } else if (r.action === 'already-synced') {
        console.log(`LocalNet clock already in sync (${r.initialDriftSeconds}s drift).`)
      } else {
        console.log('LocalNet is freshly reset (genesis); leaving at block 0 (first txn will set wall-clock).')
      }
      process.exit(0)
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err)
      process.exit(1)
    })
}
