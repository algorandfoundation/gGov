import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowRight, ChevronRight, Info } from 'lucide-react'
import { Eyebrow } from '@/components/ui/eyebrow'
import { getDocsPage, getNextDocsPage } from '@/components/pages/docs/nav'

/**
 * Shared docs prose building blocks. Most docs chrome is plain semantic markup
 * styled with the app's design tokens (which already flip for dark mode), so we
 * keep these intentionally small and local to the docs site.
 */

/** Page header: eyebrow + large display H1. */
export function DocsHeader({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div>
      <Eyebrow>{eyebrow}</Eyebrow>
      <h1 className="mt-4 font-display text-[42px] font-bold leading-[1.06] tracking-[-0.02em]">{title}</h1>
    </div>
  )
}

/** Page header resolved from the docs model by route — used by every article page. */
export function ArticleHeader({ to }: { to: string }) {
  const page = getDocsPage(to)
  if (!page) return null
  return <DocsHeader eyebrow={page.eyebrow ?? ''} title={page.title} />
}

/** Lead paragraph (20px) that opens each article. */
export function Lead({ children }: { children: ReactNode }) {
  return <p className="mt-5 max-w-[64ch] font-sans text-[20px] leading-[1.6] text-muted-foreground">{children}</p>
}

/** Body section heading (## in the spec). */
export function H2({ children }: { children: ReactNode }) {
  return (
    <h2 className="mt-11 mb-3.5 font-display text-2xl font-bold leading-[1.2] tracking-[-0.01em] text-foreground">
      {children}
    </h2>
  )
}

/** Body paragraph (17px / 1.7, ~64ch measure). */
export function P({ children }: { children: ReactNode }) {
  return <p className="mb-[18px] max-w-[64ch] font-sans text-[17px] leading-[1.7] text-muted-foreground">{children}</p>
}

/** Inline emphasis that lifts to the primary text colour. */
export function Strong({ children }: { children: ReactNode }) {
  return <strong className="font-semibold text-foreground">{children}</strong>
}

/** Inline cross-link to another docs page ("How voting power works →"). */
export function InlineLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="text-primary no-underline [border-bottom:1px_solid] border-primary/30 hover:border-primary">
      {children}
    </Link>
  )
}

type CalloutVariant = 'info' | 'neutral' | 'warning'

/**
 * Admonition block. Three variants per the spec: info = blue, neutral = inset,
 * warning = orange (used only for the delegation direct-vote rule). The orange
 * accent text mirrors the app's existing warning treatment
 * (text-[#9A4A1F] dark:text-algo-orange).
 */
export function Callout({
  variant = 'info',
  icon,
  children,
}: {
  variant?: CalloutVariant
  icon?: ReactNode
  children: ReactNode
}) {
  if (variant === 'warning') {
    return (
      <div className="my-2 mb-[18px] flex gap-3 rounded-md border border-algo-orange/30 border-l-[3px] border-l-algo-orange bg-algo-orange/10 px-[18px] py-4">
        <AlertTriangle className="mt-px size-[18px] flex-none text-algo-orange" />
        <div className="font-sans text-[15px] leading-[1.55] text-[#9A4A1F] [&_strong]:text-[#7A3A18] dark:text-algo-orange dark:[&_strong]:text-algo-orange">
          {children}
        </div>
      </div>
    )
  }
  if (variant === 'neutral') {
    return (
      <div className="my-2 mb-[18px] flex gap-3 rounded-md border border-border bg-muted px-[18px] py-4">
        <span className="mt-px flex-none text-muted-foreground">{icon}</span>
        <div className="font-sans text-[15px] leading-[1.55] text-muted-foreground">{children}</div>
      </div>
    )
  }
  return (
    <div className="my-2 mb-[18px] flex gap-3 rounded-md border border-primary/30 border-l-[3px] border-l-primary bg-primary/10 px-[18px] py-4">
      <span className="mt-px flex-none text-primary">{icon ?? <Info className="size-[18px]" />}</span>
      <div className="font-sans text-[15px] leading-[1.55] text-muted-foreground">{children}</div>
    </div>
  )
}

/**
 * "Next →" pager that closes every content page. Takes the CURRENT page's route and
 * resolves the next page from the docs model; renders nothing on the last page.
 */
export function Pager({ from }: { from: string }) {
  const next = getNextDocsPage(from)
  if (!next) return null
  return (
    <Link
      to={next.to}
      className="mt-12 flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-[22px] py-5 no-underline transition-colors hover:border-primary/40"
    >
      <div>
        <div className="font-sans text-xs text-muted-foreground">Next</div>
        <div className="mt-0.5 font-display text-[17px] font-bold text-foreground">{next.title}</div>
      </div>
      <ArrowRight className="size-5 text-primary" />
    </Link>
  )
}

/** A numbered row in the home "Start here" contents list. */
export function ContentsRow({ num, title, desc, to }: { num: string; title: string; desc: string; to: string }) {
  return (
    <Link
      to={to}
      className="flex items-baseline gap-4 border-b border-border px-2 py-[15px] no-underline transition-colors hover:bg-muted"
    >
      <span className="w-[26px] flex-none font-mono text-[13px] tabular-nums text-muted-foreground">{num}</span>
      <div className="min-w-0 flex-1">
        <div className="font-display text-[17px] font-bold text-foreground">{title}</div>
        <div className="mt-0.5 font-sans text-[14.5px] leading-[1.5] text-muted-foreground">{desc}</div>
      </div>
      <ChevronRight className="size-[17px] flex-none self-center text-muted-foreground" />
    </Link>
  )
}
