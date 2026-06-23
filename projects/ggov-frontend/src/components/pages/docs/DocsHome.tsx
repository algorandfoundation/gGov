import { Link } from '@tanstack/react-router'
import { ArrowRight, Check } from 'lucide-react'
import { Eyebrow } from '@/components/ui/eyebrow'
import { ContentsRow } from '@/components/pages/docs/components'
import { homeContents } from '@/components/pages/docs/nav'

export default function DocsHome() {
  return (
    <div>
      <Eyebrow className="text-algo-teal dark:text-algo-teal">Algorand governance · Docs</Eyebrow>
      <h1 className="mt-4 font-display text-[48px] font-bold leading-[1.05] tracking-[-0.02em]">Start here</h1>
      <p className="mt-5 max-w-[62ch] font-sans text-[20px] leading-[1.6] text-muted-foreground">
        A short, friendly guide to how Algorand governance works — read it top to bottom, or jump to whatever you need.
      </p>

      {/* primary path card (teal accent) */}
      <Link
        to="/docs/getting-started"
        className="mt-8 flex items-center gap-[18px] rounded-lg border border-algo-teal/30 bg-algo-teal/10 p-6 no-underline transition-colors hover:border-algo-teal/50"
      >
        <span className="flex size-12 flex-none items-center justify-center rounded-md bg-card text-algo-teal">
          <Check className="size-6" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-display text-[19px] font-bold text-foreground">
            New to governance? Start with the basics
          </div>
          <div className="mt-0.5 font-sans text-[15px] text-muted-foreground">
            Connect a wallet, check your voting power, and cast your first vote in a few minutes.
          </div>
        </div>
        <ArrowRight className="size-[22px] flex-none text-algo-teal" />
      </Link>

      {/* sectioned contents */}
      <div className="mt-11">
        {homeContents.map((section) => (
          <div key={section.title} className="mb-9">
            <div className="mb-1.5 flex items-center gap-3">
              <span className="font-sans text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                {section.title}
              </span>
              <span className="h-px flex-1 bg-border" />
            </div>
            {section.items.map((item) => (
              <ContentsRow key={item.num} {...item} />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
