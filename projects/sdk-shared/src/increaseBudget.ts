/**
 * Group sizing for both SDKs' writes. One exploratory simulate of the caller's group yields a
 * {@link GroupPlan}: how many `increaseBudget` calls to prepend (for reference slots and opcode
 * budget), the bracket the opup's inner-txn count sits in, and whether the AVM v13 usage-based fee
 * check needs a look. `executeTxns` (txnExecutor.ts) drives the plan; the exported
 * {@link getIncreaseBudgetBuilder} is the pessimistic single-shot form of the same thing.
 *
 * Reference padding: foreign/box references are capped at {@link MAX_APP_CALL_FOREIGN_REFERENCES}
 * per app call (accounts + apps + assets + boxes, combined), so a method touching more than that
 * needs company in the group or resource population fails with "No more transactions below
 * reference limit". `increaseBudget` is unauthenticated and does nothing at `itxns: 0`, so a pad
 * costs one min fee and buys 700 opcodes as a bonus. The pads must be app calls to the app that
 * owns the boxes: resource population only parks a box ref on a transaction that already has that
 * app available, and calls to the app itself do — which is why the pads come from the caller's own
 * group factory rather than from some generic no-op app.
 */
import { MAX_APP_CALL_FOREIGN_REFERENCES } from '@algorandfoundation/algokit-utils'
import { TransactionSignerAccount } from '@algorandfoundation/algokit-utils/types/account'
import { TransactionComposer } from '@algorandfoundation/algokit-utils/types/composer'
import {
  Algodv2,
  AtomicTransactionComposer,
  encodeUint64,
  makeEmptyTransactionSigner,
  modelsv2,
  Transaction,
  TransactionSigner,
} from 'algosdk'
import { increaseBudgetBaseCost, increaseBudgetIncrementCost, MAX_GROUP_SIZE } from './constants.js'
import { minFeeMicroAlgos } from './groupUsageFee.js'
import { noteNonce } from './noteNonce.js'
import { getSpendableBalance } from './spendable.js'

export const SIMULATE_PARAMS = {
  allowMoreLogging: true,
  allowUnnamedResources: true,
  extraOpcodeBudget: 130013,
  fixSigners: true,
  allowEmptySignatures: true,
}

/** Opcode budget per app call (outer or inner), and the pooled maximum for a full 16-txn group. */
const BUDGET_PER_APP_CALL = 700
/** App calls a group can run in total, outer and inner together. */
const MAX_GROUP_APP_CALLS = 256
const MAX_GROUP_BUDGET = BUDGET_PER_APP_CALL * MAX_GROUP_APP_CALLS

/** Sim #1: measure the real requirement without any budget failure getting in the way. */
const PLAN_SIMULATE_PARAMS = { ...SIMULATE_PARAMS, extraOpcodeBudget: MAX_GROUP_BUDGET }
/** Budget probes and fee reads: the group as it would actually run. */
const FEE_SIMULATE_PARAMS = { ...SIMULATE_PARAMS, extraOpcodeBudget: 0 }

/** Fee headroom on the probe's first txn: 256x min fee, as the pre-AVM13 code used. */
const PROBE_HEADROOM_FEE = 256_000n

/** Real-shape probes the opup search may spend (see {@link searchOpupItxns}). */
const MAX_OPUP_PROBES = 3

/** Usage a classic transaction (outer or inner) contributes, in `groupUsage` units. */
const USAGE_PER_CLASSIC_TXN = 1_000_000

const BALANCE_FAILURE = /overspend|tried to spend|below min/i
export const BUDGET_FAILURE = /budget/i
export const FEE_SHORTFALL_FAILURE = /fees is less than/i

/**
 * Reference-slot cost of each unnamed-resource kind reported by simulate. Deliberately conservative
 * versus algokit's `populateGroupResource`: an overcount costs at most one extra pad (one min fee),
 * an undercount fails populate's simulate loudly at send time.
 */
const SLOT_COST = {
  accounts: 1,
  apps: 1,
  assets: 1,
  boxes: 1,
  /** per txn-worth of boxes owned by an app other than the called one — see `slotCost` */
  boxOwnerApp: 1,
  extraBoxRefs: 1,
  appLocals: 2,
  assetHoldings: 2,
}

/** The group-builder surface this module needs from a generated typed client's `newGroup()`. */
export type GroupBuilder = {
  composer(): Promise<TransactionComposer>
  increaseBudget(args: any): any
}

export type GroupPlan = {
  /** Prepended no-op app calls needed for reference slots alone */
  padsForRefs: number
  /** Total prepends: `padsForRefs`, or 1 when an opup is needed and no pad was */
  prepends: number
  /** Optimistic opup itxn count: every inner-added budget counts. May be too low. */
  itxnsLo: number
  /** Pessimistic opup itxn count: no inner-added budget counts. Always sufficient. */
  itxnsHi: number
  /** The group's usage exceeds the classic per-txn allowance, so its fee must be read off simulate */
  feeCheckNeeded: boolean
  /** Txns in the group before prepends */
  txnCount: number
  /** ABI method names in the group, for error messages */
  methods: string[]
}

export type ProbeResult = {
  response: modelsv2.SimulateResponse
  group: modelsv2.SimulateTransactionGroupResult
  /** Fee the probe set on txn 0 */
  headroomFee: bigint
}

/**
 * What one `executeTxns` run learns and reuses across all of its simulates.
 *
 * Both cached fields exist to stop a probe rediscovering something the run already knows: without
 * them a low-balance sender re-derives its headroom on every single probe (up to eight extra
 * simulates and as many `accountInformation` calls), and the fee path refetches suggested params.
 */
export type ProbeContext = {
  algod: Algodv2
  /**
   * Placeholder signer for the sizing simulates. Should be the writer's own when it has one: the
   * AVM v13 post-quantum fee premium is priced off the signature envelope, so a plain empty signer
   * measures non-PQ usage for a PQ sender.
   */
  emptySigner: TransactionSigner
  /** Fee put on a probe's first txn, resolved once per run — see {@link probeBuilt}. */
  headroomFee?: bigint
  /** The network's min fee, fetched at most once per run. */
  minFee?: bigint
}

export const makeProbeContext = (algod: Algodv2, emptySigner?: TransactionSigner): ProbeContext => ({
  algod,
  emptySigner: emptySigner ?? makeEmptyTransactionSigner(),
})

/** The network min fee, fetched once per run. */
export const contextMinFee = async (ctx: ProbeContext): Promise<bigint> =>
  (ctx.minFee ??= await minFeeMicroAlgos(ctx.algod))

const nonEmptyGroup = (txns: Transaction[]) => {
  if (txns.length === 0) throw new Error('increaseBudget: the group has no transactions')
  return txns
}

/** The whole group's fee/payment debits against `sender`, apart from txn 0's fee. */
const otherDebits = (txns: Transaction[], sender: string): bigint =>
  txns.reduce((sum, txn, i) => {
    if (txn.sender.toString() !== sender) return sum
    const fee = i === 0 ? 0n : txn.fee
    const payment = txn.payment?.amount ?? 0n
    return sum + fee + payment
  }, 0n)

/**
 * Simulate `txns` as a group with `fee` on the first. Restores every transaction's fee and group
 * afterwards: `buildTransactions()` builds method calls fresh each time, but a transaction passed
 * as a method ARGUMENT (an MBR payment, say) is the caller's own object and comes back by
 * reference, so anything left on it would leak into the real send ("Cannot add a transaction with
 * nonzero group ID", or a 256x fee).
 */
const simulateWithFee = async (
  txns: Transaction[],
  fee: bigint,
  ctx: ProbeContext,
  params: typeof SIMULATE_PARAMS,
): Promise<modelsv2.SimulateResponse> => {
  const originals = txns.map((t) => ({ fee: t.fee, group: t.group }))
  try {
    txns[0].fee = fee
    const atc = new AtomicTransactionComposer()
    for (const txn of txns) atc.addTransaction({ txn, signer: ctx.emptySigner })
    const { simulateResponse } = await atc.simulate(
      ctx.algod,
      new modelsv2.SimulateRequest({ txnGroups: [], ...params }),
    )
    return simulateResponse
  } finally {
    txns.forEach((t, i) => {
      t.fee = originals[i].fee
      t.group = originals[i].group
    })
  }
}

/**
 * Simulate an already-built group with enough fee on its first transaction that fees never get in
 * the way of measuring it, and with placeholder signatures so nobody is prompted to sign.
 *
 * The headroom starts at 256x min fee. That fails outright for a sender that cannot cover it (an
 * `overspend` before the app even runs), so on a balance failure it is re-derived from the sender's
 * spendable balance, net of everything else it pays in the group, and the probe re-runs once. If
 * that still fails on balance, the measurement is returned as is: the send surfaces the genuine
 * insufficient-balance error.
 *
 * Whatever headroom the first probe of a run settles on is cached on `ctx` and reused by every
 * later probe, so the balance round trip happens once per run rather than once per probe.
 */
export async function probeBuilt(
  txns: Transaction[],
  ctx: ProbeContext,
  params: typeof SIMULATE_PARAMS,
): Promise<ProbeResult> {
  nonEmptyGroup(txns)
  const realFee = txns[0].fee
  // A cached headroom is a balance-derived ceiling, but it can never sit under what txn 0 was
  // built to pay — a later probe's group may carry a bigger fee than the one that set it.
  const cached = ctx.headroomFee
  let headroomFee = cached ?? PROBE_HEADROOM_FEE
  if (headroomFee < realFee) headroomFee = realFee
  let response = await simulateWithFee(txns, headroomFee, ctx, params)
  let group = response.txnGroups[0]

  if (cached === undefined) {
    if (group.failureMessage && BALANCE_FAILURE.test(group.failureMessage)) {
      const sender = txns[0].sender.toString()
      const spendable = await getSpendableBalance(ctx.algod, sender)
      const room = spendable - otherDebits(txns, sender)
      const fromBalance = room < realFee ? realFee : room > PROBE_HEADROOM_FEE ? PROBE_HEADROOM_FEE : room
      if (fromBalance !== headroomFee) {
        headroomFee = fromBalance
        response = await simulateWithFee(txns, headroomFee, ctx, params)
        group = response.txnGroups[0]
      }
    }
    ctx.headroomFee = headroomFee
  }
  return { response, group, headroomFee }
}

/** Build `composer`'s group and probe it. */
export async function probeSimulate(
  composer: TransactionComposer,
  ctx: ProbeContext,
  params: typeof SIMULATE_PARAMS,
): Promise<ProbeResult> {
  return probeBuilt((await composer.buildTransactions()).transactions, ctx, params)
}

const countInclInners = (txns: modelsv2.PendingTransactionResponse[] | undefined): number =>
  (txns ?? []).reduce((n, t) => n + 1 + countInclInners(t.innerTxns), 0)

const countInnerAppls = (txns: modelsv2.PendingTransactionResponse[] | undefined): number =>
  (txns ?? []).reduce((n, t) => n + (t.txn.txn.type === 'appl' ? 1 : 0) + countInnerAppls(t.innerTxns), 0)

/**
 * Slot cost of one unnamed-resource report.
 *
 * Box references are transaction-local: a box ref encodes against ITS OWN txn's foreign-apps
 * array, so every txn that carries boxes of an app other than the one it calls also spends a slot
 * on that app. With one owner app on a txn that leaves 7 boxes per txn, hence `b + ceil(b / 7)`
 * per foreign owner. `hostApp` is the app every app call in the group targets (boxes of it ride
 * free on the pads, which call it too); a mixed-app group gets no such discount.
 */
const slotCost = (r: modelsv2.SimulateUnnamedResourcesAccessed | undefined, hostApp: bigint | undefined): number => {
  if (r === undefined) return 0
  const boxesByOwner = new Map<bigint, number>()
  for (const box of r.boxes ?? []) {
    const owner = BigInt(box.app)
    if (owner !== hostApp) boxesByOwner.set(owner, (boxesByOwner.get(owner) ?? 0) + 1)
  }
  const ownerAppRefs = [...boxesByOwner.values()].reduce(
    (n, b) => n + Math.ceil(b / (MAX_APP_CALL_FOREIGN_REFERENCES - 1)),
    0,
  )
  return (
    (r.accounts?.length ?? 0) * SLOT_COST.accounts +
    (r.apps?.length ?? 0) * SLOT_COST.apps +
    (r.assets?.length ?? 0) * SLOT_COST.assets +
    (r.boxes?.length ?? 0) * SLOT_COST.boxes +
    ownerAppRefs * SLOT_COST.boxOwnerApp +
    Number(r.extraBoxRefs ?? 0) * SLOT_COST.extraBoxRefs +
    (r.appLocals?.length ?? 0) * SLOT_COST.appLocals +
    (r.assetHoldings?.length ?? 0) * SLOT_COST.assetHoldings
  )
}

const declaredRefs = (txn: Transaction): number => {
  const a = txn.applicationCall
  if (!a) return 0
  return a.accounts.length + a.foreignApps.length + a.foreignAssets.length + a.boxes.length
}

/**
 * Smallest opup itxn count that closes the budget gap, given `prepends` prepended app calls and
 * `available` budget already in the group. Each itxn costs `increaseBudgetIncrementCost` and adds
 * 700; the opup runs in txn 0, so its budget always lands before it is needed.
 */
const solveItxns = (consumed: number, prepends: number, available: number): number => {
  const gap = consumed + prepends * increaseBudgetBaseCost - available - prepends * BUDGET_PER_APP_CALL
  return Math.max(0, Math.ceil(gap / (BUDGET_PER_APP_CALL - increaseBudgetIncrementCost)))
}

/**
 * Sim #1: size everything the group needs on top of the caller's own calls.
 *
 * - Reference pads: slots the group's app calls declare plus the unnamed resources simulate
 *   reports (costed per {@link SLOT_COST}), against 8 per app call.
 * - Opup itxns: bracketed. Budget added by the target app's own inner app calls materializes only
 *   as those inners execute — possibly after the point of need — so it cannot be blindly counted,
 *   but never counting it (the pre-AVM13 heuristic) over-provisions. `itxnsHi` counts none of it
 *   and is safe by construction; `itxnsLo` counts all of it. When they differ, `executeTxns`
 *   binary-searches between them with real-shape probes.
 * - Fee check: `groupUsage` above the classic allowance (1e6 per txn, inners included) means the
 *   fee must be read off simulate rather than computed — big application arguments, or a
 *   post-quantum signer whose envelope the probe carried.
 *
 * A non-budget simulate failure still yields a plan: returning early used to mask real failures
 * behind out-of-budget errors. Fee logic is skipped then, since usage may be partial.
 *
 * @returns `undefined` when the group needs nothing
 */
export async function planGroupExtras(builder: GroupBuilder, ctx: ProbeContext): Promise<GroupPlan | undefined> {
  const { transactions: txns, methodCalls } = await (await builder.composer()).buildTransactions()
  nonEmptyGroup(txns)
  const methods = [...methodCalls.values()].map((m) => m.name)
  const { group } = await probeBuilt(txns, ctx, PLAN_SIMULATE_PARAMS)
  const { txnResults, failureMessage } = group
  const consumed = Number(group.appBudgetConsumed ?? 0)

  // ── reference slots ──
  const appls = txns.filter((t) => t.type === 'appl')
  const calledApps = new Set(appls.map((t) => t.applicationCall!.appIndex))
  const hostApp = calledApps.size === 1 ? appls[0].applicationCall!.appIndex : undefined
  let totalSlots = slotCost(group.unnamedResourcesAccessed, hostApp)
  txns.forEach((txn, i) => {
    if (txn.type !== 'appl') return
    const perTxn = declaredRefs(txn) + slotCost(txnResults[i]?.unnamedResourcesAccessed, hostApp)
    if (perTxn > MAX_APP_CALL_FOREIGN_REFERENCES) {
      throw new Error(
        `${methods.join('+')}: txn ${i} needs ${perTxn} reference slots on its own, over the ` +
          `${MAX_APP_CALL_FOREIGN_REFERENCES} per app call — padding cannot help.`,
      )
    }
    totalSlots += perTxn
  })
  if (totalSlots > MAX_APP_CALL_FOREIGN_REFERENCES * MAX_GROUP_SIZE) {
    throw new Error(
      `${methods.join('+')}: needs ${totalSlots} reference slots, over the ` +
        `${MAX_APP_CALL_FOREIGN_REFERENCES * MAX_GROUP_SIZE} a full group carries.`,
    )
  }
  const padsForRefs = Math.max(0, Math.ceil(totalSlots / MAX_APP_CALL_FOREIGN_REFERENCES) - appls.length)

  // ── opcode budget ──
  const innerAppls = countInnerAppls(txnResults.map((r) => r.txnResult))
  const solve = (prepends: number) => ({
    prepends,
    itxnsHi: solveItxns(consumed, prepends, BUDGET_PER_APP_CALL * appls.length),
    itxnsLo: solveItxns(consumed, prepends, BUDGET_PER_APP_CALL * (appls.length + innerAppls)),
  })
  let budget = solve(padsForRefs)
  if (budget.itxnsHi > 0 && padsForRefs === 0) budget = solve(1)
  const { prepends, itxnsHi, itxnsLo } = budget
  // The opup's inners are app calls like any other, so they share the group's app-call allowance
  // with the calls already in it. Sized against the group total rather than per transaction: a
  // single opup routinely submits far more inners than the transaction carrying it could of its
  // own accord, which is the entire point of it.
  const appCallRoom = MAX_GROUP_APP_CALLS - (appls.length + prepends)
  if (itxnsHi > appCallRoom) {
    throw new Error(
      `${methods.join('+')}: needs ${itxnsHi} opup inner txns, over the ${appCallRoom} app calls ` +
        `left in the group (${MAX_GROUP_APP_CALLS} total, ${appls.length + prepends} already used).`,
    )
  }

  // ── fees ──
  const usage = Number(group.groupUsage ?? 0)
  const feeCheckNeeded =
    (!failureMessage || FEE_SHORTFALL_FAILURE.test(failureMessage)) &&
    usage > countInclInners(txnResults.map((r) => r.txnResult)) * USAGE_PER_CLASSIC_TXN

  // `prepends`, not `padsForRefs`: a group that is over budget by less than one app call's worth
  // is solved by a single opup carrying no itxns at all, and that prepend is the whole plan.
  if (prepends === 0 && itxnsHi === 0 && !feeCheckNeeded) return undefined
  return { padsForRefs, prepends, itxnsLo, itxnsHi, feeCheckNeeded, txnCount: txns.length, methods }
}

/**
 * A fresh group from `factory` with the plan's prepends added, ready for the caller's maker to
 * append the real calls to. The first prepend carries `itxns` (and, when known, the group's fee
 * delta as a static fee); the rest are `itxns: 0` pads. Prepending keeps the opup's inners
 * executing before the heavy calls, and keeps donating the 8 ref slots some callers rely on.
 *
 * When only the fee check fired (no pads, no itxns), one `increaseBudget(0)` still goes in as the
 * fee carrier: the delta lands on it, never on the real calls, so a call's fee does not depend on
 * whether its self-paying inners (MBR top-ups) fire.
 */
export function applyPrepends<T extends GroupBuilder>(
  factory: () => T,
  plan: GroupPlan,
  sender: string,
  signer: TransactionSigner | TransactionSignerAccount,
  itxns: number,
  staticFee?: bigint,
): T {
  const prepends = Math.max(plan.prepends, 1)
  if (plan.txnCount + prepends > MAX_GROUP_SIZE) {
    throw new Error(
      `${plan.methods.join('+')}: ${plan.txnCount} txns plus ${prepends} budget/reference prepends ` +
        `is over the ${MAX_GROUP_SIZE}-txn group limit.`,
    )
  }
  const fee =
    staticFee !== undefined
      ? { staticFee: Number(staticFee).microAlgo() }
      : { extraFee: (itxns * 1000).microAlgo(), maxFee: ((itxns + 1) * 1000).microAlgo() }
  let builder = factory().increaseBudget({ args: { itxns }, sender, signer, note: `opup-${noteNonce()}`, ...fee }) as T
  for (let i = 1; i < prepends; i++) {
    // Distinct notes: otherwise identical pads would collide into one duplicate txn ID.
    builder = builder.increaseBudget({ args: { itxns: 0 }, sender, signer, note: `refs-${i}-${noteNonce()}` }) as T
  }
  return builder
}

/**
 * Replace the itxns argument (ABI arg 1, after the selector) of the opup in txn 0 of a probe copy.
 * The built `Transaction` types its app args as read-only, but they are a plain array at runtime
 * and encoding happens on demand, so the copy simulates with the candidate count without a maker
 * rerun. Returns the undo.
 */
export const setOpupItxns = (txns: Transaction[], itxns: number): (() => void) => {
  const appArgs = txns[0].applicationCall?.appArgs as Uint8Array[] | undefined
  if (!appArgs || appArgs.length < 2) throw new Error('increaseBudget: txn 0 is not the opup call')
  const original = appArgs[1]
  appArgs[1] = encodeUint64(itxns)
  return () => {
    appArgs[1] = original
  }
}

/**
 * Binary-search the opup itxn count inside `(plan.itxnsLo, plan.itxnsHi]` with at most
 * {@link MAX_OPUP_PROBES} real-shape probes of `composer` (a group built at `itxnsHi`). `itxnsHi` is
 * safe by construction, so the invariant is that the returned count either passed a probe or is
 * `itxnsHi`.
 *
 * The group is built once and each candidate swapped into txn 0's itxns argument, so the probes
 * cost simulates and nothing else.
 *
 * When the usage fee also has to be read, the last slot is held back for `hi` unless some probe has
 * already passed: a passing probe is a complete usage measurement (a budget failure is not), and
 * `hi` is guaranteed to pass, so that probe both verifies the count and prices the group — which is
 * what keeps the fee off a simulate of its own.
 *
 * A probe failing on anything but budget aborts the search: the pessimistic count goes out and the
 * send surfaces the real error.
 *
 * @returns the count and, when a probe verified it, that probe's result
 */
export async function searchOpupItxns(
  composer: TransactionComposer,
  plan: GroupPlan,
  ctx: ProbeContext,
): Promise<{ itxns: number; probe?: ProbeResult }> {
  const txns = nonEmptyGroup((await composer.buildTransactions()).transactions)
  let lo = plan.itxnsLo
  let hi = plan.itxnsHi
  let passing: ProbeResult | undefined
  let probesUsed = 0

  const probe = async (candidate: number): Promise<'pass' | 'budget' | 'other'> => {
    probesUsed++
    const restore = setOpupItxns(txns, candidate)
    let result: ProbeResult
    try {
      result = await probeBuilt(txns, ctx, FEE_SIMULATE_PARAMS)
    } finally {
      restore()
    }
    const failure = result.group.failureMessage
    if (!failure) {
      hi = candidate
      passing = result
      return 'pass'
    }
    if (BUDGET_FAILURE.test(failure)) {
      lo = candidate
      return 'budget'
    }
    return 'other'
  }

  // Optimistic first: the common inner-heavy case is that every inner's budget did arrive in time.
  const first = await probe(lo)
  if (first === 'pass') return { itxns: lo, probe: passing }
  if (first === 'other') return { itxns: plan.itxnsHi }

  // lo fails and hi passes: bisect, holding a slot back for the fee read when one is owed.
  const reserved = () => (plan.feeCheckNeeded && !passing ? 1 : 0)
  while (probesUsed < MAX_OPUP_PROBES - reserved() && lo + 1 < hi) {
    if ((await probe(Math.floor((lo + hi) / 2))) === 'other') return { itxns: plan.itxnsHi }
  }
  if (!passing && plan.feeCheckNeeded && probesUsed < MAX_OPUP_PROBES) {
    if ((await probe(hi)) === 'other') return { itxns: plan.itxnsHi }
  }
  return { itxns: hi, probe: passing }
}

/**
 * Simulate and return `undefined` if the group needs nothing, otherwise a new builder from
 * `newBuilderFactory` with the needed `increaseBudget` calls prepended (opcode budget AND
 * reference-slot pads), for the caller to add its real calls to.
 *
 * Sizes the opup at the pessimistic bound: this wrapper cannot rerun the caller's maker, so it
 * cannot probe the final group shape. Safe, and no worse than the pre-AVM13 behavior; the
 * optimistic search lives in `executeTxns`.
 *
 * `emptyTxnSigner` is the writer's own placeholder signer, when it has one — a post-quantum sender
 * must pass it or the probe measures the group as classic. See {@link makeProbeContext}.
 */
export async function getIncreaseBudgetBuilder<T extends GroupBuilder>(
  builder: T,
  newBuilderFactory: () => T,
  sender: string,
  signer: TransactionSigner | TransactionSignerAccount,
  algod: Algodv2,
  emptyTxnSigner?: TransactionSigner,
): Promise<T | undefined> {
  const plan = await planGroupExtras(builder, makeProbeContext(algod, emptyTxnSigner))
  return plan && applyPrepends(newBuilderFactory, plan, sender, signer, plan.itxnsHi)
}
