import { AlgoQuartersFile } from '../instance/types'

const UINT32_MAX = 0xffffffffn

/**
 * Validate an AQ manifest and parse its decimal-string values: row count and AQ sum must match the
 * declared totals, every AQ must fit uint32, no duplicate addresses. Throws on the first violation.
 */
export const parseAqFile = (aqFile: AlgoQuartersFile): { account: string; aq: number }[] => {
  const { accounts, totalAccounts, totalAlgoQuarters } = aqFile
  if (!Number.isInteger(totalAccounts) || totalAccounts <= 0) {
    throw new Error(`uploadAqFile: totalAccounts must be a positive integer, got ${totalAccounts}`)
  }
  if (accounts.length !== totalAccounts) {
    throw new Error(`uploadAqFile: ${accounts.length} accounts != declared totalAccounts ${totalAccounts}`)
  }
  const totalAq = BigInt(totalAlgoQuarters)
  if (totalAq <= 0n || totalAq > UINT32_MAX) {
    throw new Error(`uploadAqFile: totalAlgoQuarters ${totalAlgoQuarters} out of uint32 range`)
  }
  const seen = new Set<string>()
  let sum = 0n
  const rows = accounts.map(({ account, algoQuarters }) => {
    const aq = BigInt(algoQuarters)
    if (aq <= 0n || aq > UINT32_MAX) {
      throw new Error(`uploadAqFile: AQ for ${account} out of uint32 range: ${algoQuarters}`)
    }
    if (seen.has(account)) throw new Error(`uploadAqFile: duplicate account ${account}`)
    seen.add(account)
    sum += aq
    return { account, aq: Number(aq) }
  })
  if (sum !== totalAq) {
    throw new Error(`uploadAqFile: sum of account AQ ${sum} != declared totalAlgoQuarters ${totalAq}`)
  }
  return rows
}
