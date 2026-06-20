import { getOpenInEntries, type Network } from '@d13co/open-in'
import { ExternalLink } from 'lucide-react'
import { getAlgodConfigFromViteEnvironment } from '@/utils/network'
import { cn } from '@/lib/utils'

/**
 * Renders an application ID as `#<id>` linking to its application page on a block
 * explorer for the configured network (first entry from @d13co/open-in — e.g. Lora
 * on localnet, Pera on testnet, Allo on mainnet). Falls back to plain text when no
 * explorer supports the network.
 */
export default function AppExplorerLink({
  appId,
  className,
}: {
  appId: number | bigint | string
  className?: string
}) {
  const id = appId.toString()
  const network = getAlgodConfigFromViteEnvironment().network as Network
  const [explorer] = getOpenInEntries(network, 'application')
  const url = explorer?.getUrl(network, 'application', id)

  if (!explorer || !url) {
    return <span className={cn('tabular-nums', className)}>#{id}</span>
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className={cn('inline-flex items-center gap-1 tabular-nums text-primary hover:underline dark:text-algo-teal', className)}
    >
      #{id}
      <ExternalLink className="size-3.5" />
    </a>
  )
}
