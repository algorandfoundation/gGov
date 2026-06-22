import { Link } from 'react-router-dom'
import { AlgorandLogo } from '@/components/Brand'

const footerLinks = [
  { href: 'https://algorand.co/algorand-foundation/disclaimer', label: 'Disclaimer' },
  { href: 'https://algorand.co/algorand-foundation/privacy-policy', label: 'Privacy Policy' },
  { href: 'https://github.com/algorandfoundation/gGov', label: 'GitHub' },
]

export default function Footer() {
  return (
    <footer className="border-t px-4 py-6">
      <div className="relative flex items-center justify-between sm:justify-center">
        <AlgorandLogo className="text-primary size-6 shrink-0 sm:absolute sm:left-0 sm:top-1/2 sm:-translate-y-1/2" />
        <nav className="flex flex-col items-end gap-x-6 gap-y-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-center">
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
      </div>
    </footer>
  )
}
