import { Indexer } from 'algosdk'

// Number of rounds per scan window — constrains min/max-round to prevent indexer SQL timeouts.
// 1M rounds ≈ 1 month.
export const SCAN_WINDOW = 1_000_000n

function getIndexerUrl(): string {
  return (process.env.INDEXER_SERVER ?? 'https://mainnet-idx.4160.nodely.dev').replace(/\/$/, '')
}

export function createIndexerClient(): Indexer {
  const serverUrl = getIndexerUrl()
  const token = process.env.INDEXER_TOKEN ?? ''
  const parsed = new URL(serverUrl)
  const port = parsed.port || ''
  const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '')
  const base = `${parsed.protocol}//${parsed.hostname}${pathname}`
  return new Indexer(token ? { 'X-Indexer-API-Token': token } : {}, base, port)
}
