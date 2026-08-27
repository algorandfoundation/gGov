import { SendParams } from '@algorandfoundation/algokit-utils/types/transaction'
import { Algodv2 } from 'algosdk'
import {
  applyPrepends,
  BUDGET_FAILURE,
  contextMinFee,
  FEE_SHORTFALL_FAILURE,
  GroupPlan,
  makeProbeContext,
  planGroupExtras,
  probeSimulate,
  ProbeResult,
  searchOpupItxns,
  SIMULATE_PARAMS,
} from './increaseBudget.js'
import { feeFromGroupUsage, feeFromUsageRejection } from './groupUsageFee.js'
import { SendResult, SenderWithSigner } from './types.js'

/** Budget probes and fee reads: the group as it would actually run. */
const FEE_SIMULATE_PARAMS = { ...SIMULATE_PARAMS, extraOpcodeBudget: 0 }

/** Send-time backstop: how many times a budget failure at send is answered with more itxns. */
const MAX_BUDGET_RETRIES = 2

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Execute a transaction group, sizing its budget, reference slots and fee automatically.
 * Shared between the registry SDKs and the top-level per-app SDKs.
 *
 * Flow (simulate counts in brackets; `builder.send()` always ends with algokit's own
 * resource-population simulate, a free final verification pass):
 *
 * 1. Sim #1 (`planGroupExtras`) on the maker's bare group: reference pads, the opup bracket
 *    `[itxnsLo, itxnsHi]`, and whether the v13 usage fee needs reading. Nothing needed → send. [2]
 * 2. Rerun the maker at `itxnsHi`, the count that is safe whatever order the target app's own
 *    inner calls run in. Inner budget only materialises as those inners execute, so it cannot be
 *    counted on to arrive in time — a 1400-opcode call whose inner fires at the very end starts on
 *    700 and runs out first — but never counting it over-provisions. Probe the bracket on mutated
 *    copies of that group to find how much of it actually did arrive. [+0-3]
 * 3. Decide the opup count and, if the group's usage is past the classic allowance, its fee — both
 *    read off a probe already taken — then rerun the maker once more, at the final shape. [+0]
 * 4. Send. A budget failure at send bumps the itxns (twice at most); a usage-fee rejection is
 *    re-priced from the rejection itself. Both are backstops for probe/send divergence, not the
 *    normal path. [+1 each]
 *
 * Worst case is 9 simulates; the common path, where the group needs nothing at all, is 2.
 *
 * The fee delta lands only on the prepended opup, never the real calls, so a call's fee does not
 * depend on whether its self-paying inners (MBR top-ups) fire.
 */
export async function executeTxns<T extends { builder?: any; readCache?: Map<string, unknown> }>({
  txnBuilder,
  txnBuilderArgs,
  emptyGroupBuilder,
  sendParams,
  writerAccount,
  algod,
}: {
  txnBuilder: (args: T) => Promise<any>
  txnBuilderArgs: T
  emptyGroupBuilder: () => any
  sendParams?: SendParams
  writerAccount: SenderWithSigner
  algod: Algodv2
}): Promise<SendResult> {
  const sender = writerAccount.sender.toString()
  const signer = writerAccount.signer
  // The writer's own placeholder signer prices a post-quantum envelope; a plain empty signer does not.
  const ctx = makeProbeContext(algod, writerAccount.emptyTxnSigner)
  // One cache for the whole run: the maker is re-run up to three times, and without this every
  // rerun repeats whatever reads it does to size its own call (escrow counts and the like).
  const readCache = new Map<string, unknown>()

  let builder = await txnBuilder({ ...txnBuilderArgs, readCache })
  let plan = await planGroupExtras(builder, ctx)
  if (!plan) {
    try {
      return await builder.send(sendParams)
    } catch (e) {
      if (!BUDGET_FAILURE.test(errorText(e))) throw e
      // Sim #1 said the group fits, the send disagreed: fall through to the retry ladder with a
      // minimal plan, the same way an over-budget group would have started.
      plan = {
        padsForRefs: 0,
        prepends: 1,
        itxnsLo: 0,
        itxnsHi: 0,
        feeCheckNeeded: false,
        txnCount: await (await builder.composer()).count(),
        methods: [],
      }
    }
  }
  const settled: GroupPlan = plan

  let itxns = settled.itxnsHi
  let staticFee: bigint | undefined
  const rebuild = async () => {
    builder = await txnBuilder({
      ...txnBuilderArgs,
      readCache,
      builder: applyPrepends(emptyGroupBuilder, settled, sender, signer, itxns, staticFee),
    })
  }

  /**
   * Put the group's real fee on the first prepend, from a probe of the group as it will run.
   *
   * `groupFeesPaid - headroomFee` is everything the group pays apart from txn 0, and the probe ran
   * the same inner count as the final group will, so the fee txn 0 has to carry is exactly the
   * shortfall against that. Reading it this way means the answer does not depend on what txn 0 was
   * *built* with, which is what makes a probe taken at a larger opup count still usable.
   */
  /** Raise the opup's static fee to `required`, never below what txn 0 owes for its own inners. */
  const raiseStaticFee = (required: bigint, minFee: bigint): boolean => {
    const floor = BigInt(1 + itxns) * minFee
    const next = required > floor ? required : floor
    if (staticFee !== undefined && next <= staticFee) return false
    staticFee = next
    return true
  }

  const usageFeeFrom = async (probe: ProbeResult): Promise<boolean> => {
    const { failureMessage, groupFeesPaid, groupUsage } = probe.group
    // Anything but a clean run or a usage shortfall means the usage figure may be partial.
    if ((failureMessage && !FEE_SHORTFALL_FAILURE.test(failureMessage)) || groupUsage === undefined) return false
    const minFee = await contextMinFee(ctx)
    const required = feeFromGroupUsage(probe.response, minFee)
    return raiseStaticFee(required - (BigInt(groupFeesPaid ?? 0) - probe.headroomFee), minFee)
  }

  await rebuild()

  let probe: ProbeResult | undefined
  if (settled.itxnsLo < settled.itxnsHi) {
    const found = await searchOpupItxns(await builder.composer(), settled, ctx)
    probe = found.probe
    itxns = found.itxns
  }
  // Decide the fee before rebuilding, so the opup count and the fee cost one maker rerun between
  // them rather than one each.
  if (settled.feeCheckNeeded) {
    await usageFeeFrom(probe ?? (await probeSimulate(await builder.composer(), ctx, FEE_SIMULATE_PARAMS)))
  }
  if (itxns !== settled.itxnsHi || staticFee !== undefined) await rebuild()

  let budgetRetries = 0
  let feeRetried = false
  for (;;) {
    try {
      return await builder.send(sendParams)
    } catch (e) {
      const message = errorText(e)
      if (BUDGET_FAILURE.test(message) && budgetRetries < MAX_BUDGET_RETRIES) {
        budgetRetries++
        // Two steps up, capped at the safe bound first; past it only when even that failed.
        itxns = itxns < settled.itxnsHi ? Math.min(itxns + 2, settled.itxnsHi) : itxns + 2
        await rebuild()
        continue
      }
      if (FEE_SHORTFALL_FAILURE.test(message) && !feeRetried) {
        feeRetried = true
        // The rejection names the usage it wanted, so re-pricing costs no simulate; probing is
        // only the fallback for a message that does not carry the figure.
        const minFee = await contextMinFee(ctx)
        const fromMessage = feeFromUsageRejection(message, minFee)
        const repriced =
          fromMessage === undefined
            ? await usageFeeFrom(await probeSimulate(await builder.composer(), ctx, FEE_SIMULATE_PARAMS))
            : raiseStaticFee(fromMessage, minFee)
        if (repriced) {
          await rebuild()
          continue
        }
      }
      throw e
    }
  }
}

/**
 * Create a makeTxnExecutor factory bound to a specific SDK instance.
 * Returns a function with the same signature as the per-SDK makeTxnExecutor.
 */
export function createTxnExecutor(
  sdkInstance: object,
  emptyGroupBuilder: () => any,
  wrapErrorsFn: <U>(p: Promise<U>) => Promise<U>,
  getWriterAccount: () => SenderWithSigner | undefined,
  getAlgod: () => Algodv2,
) {
  return <T extends (...args: any) => any, R = SendResult>({
    maker,
    returnTransformer,
    sendParams,
  }: {
    maker: T
    returnTransformer?: (result: SendResult) => R
    sendParams?: SendParams
  }) => {
    return async (args: Omit<Parameters<T>[0], 'builder'>): Promise<R> => {
      const writerAccount = getWriterAccount()
      if (!writerAccount) {
        throw new Error(`writerAccount not set on the SDK instance`)
      }
      const result = await wrapErrorsFn(
        executeTxns({
          txnBuilder: (args) => maker.bind(sdkInstance)(args),
          txnBuilderArgs: args,
          emptyGroupBuilder,
          sendParams,
          writerAccount,
          algod: getAlgod(),
        }),
      )
      if (returnTransformer) {
        return returnTransformer(result)
      }
      return result as R
    }
  }
}
