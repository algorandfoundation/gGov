/** Optional transfer log used to inspect Indexer scans. */

import { createWriteStream } from 'node:fs'
import { finished } from 'node:stream/promises'

import type { AssetTransfer } from '../types.ts'

function transferType(transfer: AssetTransfer): string {
  if (transfer.sender === transfer.receiver && transfer.amount === 0n) return 'opt-in'.padEnd(9)
  if (transfer.closeTo) return 'close-out'
  return 'transfer'.padEnd(9)
}

function formatTransfer(asset: string, transfer: AssetTransfer): string {
  let line = `[${asset}]  ${transfer.round}:${transfer.intraOffset}  ${transferType(transfer)}  ${transfer.sender}  ${transfer.receiver}  ${transfer.amount.toLocaleString()}`
  if (transfer.closeTo) {
    line += `  close-to: ${transfer.closeTo} +${(transfer.closeAmount ?? 0n).toLocaleString()}`
  }
  return line
}

export function openTransferLog(path: string) {
  const stream = createWriteStream(path, { flags: 'w' })
  const completion = finished(stream)
  completion.catch(() => undefined)

  return {
    write(asset: string, transfer: AssetTransfer): void {
      stream.write(`${formatTransfer(asset, transfer)}\n`)
    },
    async close(): Promise<void> {
      if (!stream.destroyed) stream.end()
      await completion
    },
  }
}
