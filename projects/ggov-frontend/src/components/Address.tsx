import { Link } from '@tanstack/react-router'
import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { useAddressName } from '@/hooks/use-nfd'
import { ellipseAddress } from '@/utils/ellipseAddress'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface AddressProps {
  address: string
  /** Ellipse width when falling back to the raw address. */
  width?: number
  /** `true` links to `/account/{address}`; a string links to that path; absent renders plain text. */
  to?: string | boolean
  /** Show a click-to-copy icon (default true). */
  copy?: boolean
  /** Show a hover tooltip with the full raw address (default true). */
  tooltip?: boolean
  /** When a name resolves, show both the NFD name and the ellipsed address. */
  long?: boolean
  /** Classes applied to the text/link element, e.g. "text-primary hover:underline". */
  className?: string
}

export default function Address({
  address,
  width = 6,
  to,
  copy = true,
  tooltip = true,
  long = false,
  className,
}: AddressProps) {
  const { data: name } = useAddressName(address)
  const ellipsed = ellipseAddress(address, width)
  const display = name ? (
    long ? (
      <>
        {name} <span className="font-mono font-normal opacity-60">({ellipsed})</span>
      </>
    ) : (
      name
    )
  ) : (
    ellipsed
  )
  // Raw addresses get monospace; resolved .algo names render in the normal font.
  const textClassName = cn(!name && 'font-mono', className)

  const text = to ? (
    <Link to={to === true ? `/account/${address}` : to} className={textClassName}>
      {display}
    </Link>
  ) : (
    <span className={textClassName}>{display}</span>
  )

  const copyAddress = () => {
    void navigator.clipboard.writeText(address)
    toast.success('Address copied')
  }

  return (
    <span className="inline-flex items-center gap-1">
      {tooltip ? (
        <Tooltip>
          <TooltipTrigger asChild>{text}</TooltipTrigger>
          <TooltipContent>
            <span className="font-mono">{address}</span>
            {name && <div className="opacity-70">{name}</div>}
          </TooltipContent>
        </Tooltip>
      ) : (
        text
      )}
      {copy && (
        <button
          type="button"
          aria-label="Copy address"
          onClick={copyAddress}
          className="text-muted-foreground hover:text-foreground"
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
      )}
    </span>
  )
}
