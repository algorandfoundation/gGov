import { getOpenInEntries, type Network } from '@d13co/open-in'
import { ExternalLink } from 'lucide-react'
import { getAlgodConfigFromViteEnvironment } from '@/utils/network'
import { cn } from '@/lib/utils'

/**
 * Icon-only link that opens an account address on a block explorer for the
 * configured network (first entry from @d13co/open-in — e.g. Lora on localnet,
 * Pera on testnet, Allo on mainnet). Renders nothing when no explorer supports
 * the network.
 */
export default function AccountExplorerLink({ address, className }: { address: string; className?: string }) {
  const network = getAlgodConfigFromViteEnvironment().network as Network
  const [explorer] = getOpenInEntries(network, 'account')
  const url = explorer?.getUrl(network, 'account', address)

  if (!explorer || !url) return null

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Open in explorer"
      title="Open in explorer"
      className={cn('text-muted-foreground hover:text-foreground', className)}
    >
      <ExternalLink className="size-3.5" />
    </a>
  )
}
