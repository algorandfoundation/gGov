import { getOpenInEntries, type Network } from '@d13co/open-in'
import { getApplicationAddress } from 'algosdk'
import { ExternalLink } from 'lucide-react'
import { usePeriodAppId } from '@/hooks/queries'
import { getAlgodConfigFromViteEnvironment } from '@/utils/network'
import { cn } from '@/lib/utils'

/**
 * Link to the period's on-chain GGovPeriod app on a block explorer. Uses @d13co/open-in
 * to pick an `account`-page explorer for the configured network (first entry returned —
 * e.g. Lora on localnet, Pera on testnet, Allo on mainnet) and links to the app's address.
 * Renders nothing until the app ID resolves or if no explorer supports this network.
 */
export default function PeriodAppExplorerLink({ periodId, className }: { periodId: number; className?: string }) {
  const { data: appId } = usePeriodAppId(periodId)
  if (appId === undefined) return null

  const network = getAlgodConfigFromViteEnvironment().network as Network
  const address = getApplicationAddress(appId).toString()
  const [explorer] = getOpenInEntries(network, 'account')
  const url = explorer?.getUrl(network, 'account', address)
  if (!explorer || !url) return null

  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className={cn('inline-flex items-center gap-1 text-sm text-primary hover:underline', className)}
    >
      View period app #{appId.toString()} on {explorer.siteName}
      <ExternalLink className="h-3.5 w-3.5" />
    </a>
  )
}
