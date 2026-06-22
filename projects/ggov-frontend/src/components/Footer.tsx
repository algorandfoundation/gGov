import { Link } from '@tanstack/react-router'
import { AlgorandLogo } from '@/components/Brand'
import { cn } from '@/lib/utils'

const footerLinks = [
  { href: 'https://github.com/algorandfoundation/gGov', label: 'Source Code' },
  { href: 'https://algorand.co/algorand-foundation/disclaimer', label: 'Disclaimer' },
  { href: 'https://algorand.co/algorand-foundation/privacy-policy', label: 'Privacy Policy' },
]

/**
 * Site footer. `className` styles the full-width `<footer>` (e.g. outer padding)
 * and `containerClassName` constrains the inner content so it lines up with the
 * page's header/content (the max-width container differs per layout).
 */
export default function Footer({ className, containerClassName }: { className?: string; containerClassName?: string }) {
  return (
    <footer className={cn('border-t py-6', className)}>
      <div className={cn('flex items-center justify-between', containerClassName)}>
        <AlgorandLogo className="text-muted-foreground size-6 shrink-0" />
        <nav className="flex flex-col items-end gap-x-6 gap-y-2 sm:flex-1 sm:flex-row sm:flex-wrap sm:items-center sm:justify-center">
          <Link to="/docs" className="text-muted-foreground hover:text-foreground text-sm transition-colors">
            Documentation
          </Link>
          {footerLinks.map(({ href, label }) => (
            <a
              key={href}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground text-sm transition-colors"
            >
              {label}
            </a>
          ))}
        </nav>
        {/* Mirrors the logo's width so the centered nav stays optically centered on desktop. */}
        <span aria-hidden className="hidden size-6 shrink-0 sm:block" />
      </div>
    </footer>
  )
}
