const footerLinks = [
  { href: 'https://algorand.co/algorand-foundation/disclaimer', label: 'Disclaimer' },
<<<<<<< feat/branding
  { href: 'https://algorand.co/algorand-foundation/privacy-policy', label: 'Privacy policy' },
=======
  { href: 'https://algorand.co/algorand-foundation/privacy-policy', label: 'Privacy Policy' },
>>>>>>> main
  { href: 'https://github.com/algorandfoundation/gGov', label: 'GitHub' },
]

export default function Footer() {
  return (
    <footer className="border-t px-4 py-6">
      <nav className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
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
    </footer>
  )
}
