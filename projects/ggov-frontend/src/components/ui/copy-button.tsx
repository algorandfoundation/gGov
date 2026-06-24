import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import type { VariantProps } from 'class-variance-authority'

interface CopyButtonProps extends VariantProps<typeof buttonVariants> {
  value: string
  children?: ReactNode
  className?: string
}

/** Button that copies `value` to the clipboard and briefly confirms the copy. */
export function CopyButton({ value, children = 'Copy', variant = 'outline', size = 'sm', className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current)
    }
  }, [])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      if (resetTimer.current) clearTimeout(resetTimer.current)
      resetTimer.current = setTimeout(() => setCopied(false), 2000)
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
