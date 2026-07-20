import { Algodv2 } from 'algosdk'

/**
 * An account's spendable µAlgo: balance minus min-balance requirement, floored at 0 — what the
 * account can actually put toward payments or new box MBR.
 */
export const getSpendableBalance = async (algod: Algodv2, address: string): Promise<bigint> => {
  const info = await algod.accountInformation(address).do()
  const amount = BigInt(info.amount)
  const minBalance = BigInt(info.minBalance)
  return amount > minBalance ? amount - minBalance : 0n
}
