import { useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button, type buttonVariants } from '@/components/ui/button'
import type { VariantProps } from 'class-variance-authority'

interface CopyButtonProps extends VariantProps<typeof buttonVariants> {
  value: string
  children?: ReactNode
  className?: string
}

/** Button that copies `value` to the clipboard and briefly confirms the copy. */
export function CopyButton({
  value,
  children = 'Copy',
  variant = 'outline',
  size = 'sm',
  className,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard can be unavailable (insecure context / denied permission); ignore.
    }
  }

  return (
    <Button variant={variant} size={size} className={className} onClick={handleCopy}>
      {copied ? <Check /> : <Copy />}
      {copied ? 'Copied!' : children}
    </Button>
  )
}
