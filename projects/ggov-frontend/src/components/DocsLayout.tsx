import { Suspense, useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { ArrowRight, Menu, Moon, Sun } from 'lucide-react'
import { useTheme } from '@/hooks/useTheme'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { docsNav } from '@/components/pages/docs/nav'
import { cn } from '@/lib/utils'

function AlgorandLogo({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24" className={className}>
      <path fill="currentColor" d="m6.142 21 8.221-14.227.99 3.683L9.268 21h3.115l3.953-6.844L18.181 21h2.792l-2.729-10.166L20.18 7.2h-2.836L16.138 3h-2.72L3.028 21z" />
    </svg>
  )
}

/** Logo + "DOCS" wordmark; clicking it returns to the docs home. */
function DocsWordmark({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link to="/docs" onClick={onNavigate} className="flex items-center gap-3 text-foreground">
      <AlgorandLogo className="size-6" />
      <span className="border-l border-border pl-3 font-sans text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        Docs
      </span>
    </Link>
  )
}

function ThemeToggle() {
  const { theme, toggle } = useTheme()
  const ariaLabel = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={ariaLabel}
      title="Toggle theme"
      className="flex size-[38px] items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:text-foreground"
    >
      {theme === 'dark' ? <Sun className="size-[17px]" /> : <Moon className="size-4" />}
    </button>
  )
}

/** A single sidebar link. Active = blue tint + a left accent bar. */
function SidebarLink({ to, label, onNavigate }: { to: string; label: string; onNavigate?: () => void }) {
  return (
    <NavLink
      to={to}
      end={to === '/docs'}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          // IMPORTANT: set the whole border-left in both states so React never
          // leaves a stale accent bar on a previously-active item (see brief).
          'block rounded-sm px-3 py-[7px] font-sans text-[14.5px] no-underline transition-colors',
          isActive
            ? 'border-l-2 border-primary bg-primary/10 font-semibold text-primary'
            : 'border-l-2 border-transparent font-medium text-muted-foreground hover:text-foreground',
        )
      }
    >
      {label}
    </NavLink>
  )
}

/** The grouped nav, shared by the desktop sidebar and the mobile drawer. */
function DocsNav({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      {docsNav.map((group, i) => (
        <div key={group.title || `ungrouped-${i}`} className="mb-[26px]">
          {group.title && (
            <div className="mb-2 px-3 font-sans text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
              {group.title}
            </div>
          )}
          <div className="flex flex-col gap-0.5">
            {group.items.map((item) => (
              <SidebarLink key={item.to} to={item.to} label={item.label} onNavigate={onNavigate} />
            ))}
          </div>
        </div>
      ))}
    </>
  )
}

export default function DocsLayout() {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const { pathname, hash } = useLocation()

  // Client-side navigation keeps the previous scroll position, so moving between
  // docs pages can land you mid-article. Reset to the top on each navigation —
  // but only when there's no fragment, so deep links to a heading anchor still
  // scroll to their target.
  useEffect(() => {
    if (!hash) window.scrollTo(0, 0)
  }, [pathname, hash])

  return (
    <div className="min-h-svh bg-background text-foreground">
      {/* top bar */}
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-[15px] md:px-7">
        <div className="flex items-center gap-2">
          {/* mobile: hamburger opens the nav drawer */}
          <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
            <SheetTrigger asChild>
              <button
                type="button"
                aria-label="Open menu"
                className="flex size-9 items-center justify-center rounded-md border border-border text-foreground md:hidden"
              >
                <Menu className="size-[18px]" />
              </button>
            </SheetTrigger>
            <SheetContent side="left" className="w-[280px] gap-0 p-0">
              <SheetHeader className="border-b border-border">
                <SheetTitle>
                  <DocsWordmark onNavigate={() => setDrawerOpen(false)} />
                </SheetTitle>
                <SheetDescription className="sr-only">Documentation navigation</SheetDescription>
              </SheetHeader>
              <nav className="overflow-y-auto px-5 py-6">
                <DocsNav onNavigate={() => setDrawerOpen(false)} />
              </nav>
            </SheetContent>
          </Sheet>
          <DocsWordmark />
        </div>
        <div className="flex items-center gap-3 md:gap-[18px]">
          {/* TODO: wire up docs search to a real index before re-enabling. <SearchAffordance /> */}
          <ThemeToggle />
          <Button asChild size="sm">
            <Link to="/vote">
              <span className="hidden sm:inline">Open governance app</span>
              <span className="sm:hidden">App</span>
              <ArrowRight />
            </Link>
          </Button>
        </div>
      </header>

      {/* shell: sticky sidebar + centred reading column */}
      <div className="md:grid md:grid-cols-[260px_1fr] md:items-start">
        <nav className="sticky top-0 hidden border-r border-border px-5 pb-16 pt-[30px] md:block">
          <DocsNav />
        </nav>
        <div className="flex min-w-0 justify-center px-6 pb-20 pt-12 md:px-14 md:pt-14">
          <div className="w-full max-w-[720px]">
            <Suspense fallback={<Skeleton className="h-64 w-full" />}>
              <Outlet />
            </Suspense>
          </div>
        </div>
      </div>
    </div>
  )
}
