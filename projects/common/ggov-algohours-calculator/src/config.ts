import { Indexer } from 'algosdk'

// Number of rounds per scan window — constrains min/max-round to prevent indexer SQL timeouts.
// 1M rounds ≈ 1 month.
export const SCAN_WINDOW = 1_000_000n

// Snapshots are saved at multiples of this interval
export const SNAPSHOT_INTERVAL = 1_000_000n
// Sanity cap on an algohours window: committee windows are ~3M rounds; anything bigger is almost surely a typo
export const MAX_WINDOW = 10n * SNAPSHOT_INTERVAL

function getIndexerUrl(): string {
  return (process.env.INDEXER_SERVER ?? 'https://mainnet-idx.4160.nodely.dev').replace(/\/$/, '')
}

export function createIndexerClient(): Indexer {
  const serverUrl = getIndexerUrl()
  const token = process.env.INDEXER_TOKEN ?? ''
  const parsed = new URL(serverUrl)
  if (token && parsed.protocol !== 'https:') {
    throw new Error(`INDEXER_TOKEN would be sent unencrypted to ${parsed.hostname} — use an https INDEXER_SERVER.`)
  }
  const port = parsed.port || ''
  const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '')
  const base = `${parsed.protocol}//${parsed.hostname}${pathname}`
  return new Indexer(token ? { 'X-Indexer-API-Token': token } : {}, base, port)
}
