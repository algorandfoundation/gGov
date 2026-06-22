import { getOpenInEntries, type Network } from '@d13co/open-in'
import { ExternalLink } from 'lucide-react'
import { getAlgodConfigFromViteEnvironment } from '@/utils/network'
import { cn } from '@/lib/utils'

/**
 * Renders an application ID as `<prefix><id>` (default `#<id>`) linking to its
 * application page on a block explorer for the configured network (first entry from
 * @d13co/open-in — e.g. Lora on localnet, Pera on testnet, Allo on mainnet). Falls
 * back to plain text when no explorer supports the network.
 */
export default function AppExplorerLink({
  appId,
  prefix = '#',
  className,
}: {
  appId: number | bigint | string
  /** Label shown before the id; e.g. `'App '` to render `App 1234` instead of `#1234`. */
  prefix?: string
  className?: string
}) {
  const id = appId.toString()
  const network = getAlgodConfigFromViteEnvironment().network as Network
  const [explorer] = getOpenInEntries(network, 'application')
  const url = explorer?.getUrl(network, 'application', id)

  if (!explorer || !url) {
    return <span className={cn('tabular-nums', className)}>{prefix}{id}</span>
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn('inline-flex items-center gap-1 tabular-nums text-primary hover:underline dark:text-algo-teal', className)}
    >
      {prefix}{id}
      <ExternalLink className="size-3.5" />
    </a>
  )
}
