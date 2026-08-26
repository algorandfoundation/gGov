import { Algodv2, modelsv2 } from 'algosdk'

/** Denominator in the AVM v13 fee formula: `fee = ceil(min_fee * group_usage / 1_000_000)`. */
const USAGE_SCALE = 1_000_000

/**
 * Fee (µAlgo) a group must carry, derived from the usage AVM v13 reports for it.
 *
 * v13 prices fees on a usage metric tallied across the whole group, including inner transactions
 * generated at runtime. A free allowance covers everything that was constructible before v13, so
 * ordinary calls are unaffected — but anything using the raised limits (here, ~8KB of application
 * arguments) lands past it and is rejected at the old flat minimum with
 * "txgroup with 1mA fees is less than 1.203mA (usage=1.202600 * base=1mA)".
 *
 * The official guidance is not to reimplement the usage calculation, since inner transaction counts
 * and sizes vary at runtime — simulate and read the real figure instead, which is what this does.
 * algokit-utils cannot help here: `coverAppCallInnerTransactionFees` tops up from simulate's
 * `requiredFeeDelta`, which accounts only for inner transaction fees and reports no deficit for a
 * usage shortfall, so the group still goes out at the minimum and is rejected.
 *
 * Simulate must itself be run with a fee high enough to pass, hence the generous fee on the
 * probing build; the value returned here is the actual amount to send.
 */
export function feeFromGroupUsage(simulateResponse: modelsv2.SimulateResponse, minFee: bigint): bigint {
  const usage = simulateResponse.txnGroups[0]?.groupUsage
  if (usage === undefined) return minFee
  const required = (BigInt(minFee) * BigInt(usage) + BigInt(USAGE_SCALE) - 1n) / BigInt(USAGE_SCALE)
  return required > minFee ? required : minFee
}

/** The network's current minimum fee, in µAlgo. */
export async function minFeeMicroAlgos(algod: Algodv2): Promise<bigint> {
  const { minFee } = await algod.getTransactionParams().do()
  return BigInt(minFee ?? 1000)
}
