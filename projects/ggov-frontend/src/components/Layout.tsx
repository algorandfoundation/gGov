import { Suspense, useState } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useWallet } from '@txnlab/use-wallet-react'
import { useGlobalState } from '@/hooks/queries'
import { useTheme } from '@/hooks/useTheme'
import { useIsMobile } from '@/hooks/use-mobile'
import TopBarAccount from '@/components/TopBarAccount'
import Footer from '@/components/Footer'
import { Button } from '@/components/ui/button'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { Vote, Users, UserCircle, Settings, Sun, Moon, RefreshCw, type LucideIcon } from 'lucide-react'

function AlgorandLogo({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24" className={className}>
      <path fill="currentColor" d="m6.142 21 8.221-14.227.99 3.683L9.268 21h3.115l3.953-6.844L18.181 21h2.792l-2.729-10.166L20.18 7.2h-2.836L16.138 3h-2.72L3.028 21z" />
    </svg>
  )
}

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
}

/** Nav entries shared by the desktop top bar and the mobile drawer. */
function useNavItems(): NavItem[] {
  const { activeAddress } = useWallet()
  const { data: globalState } = useGlobalState()
  const isOperator = !!activeAddress && !!globalState?.operator && activeAddress === globalState.operator

  return [
    { to: '/vote', label: 'Vote', icon: Vote },
    { to: '/committees', label: 'Committees', icon: Users },
    ...(activeAddress ? [{ to: `/account/${activeAddress}`, label: 'My account', icon: UserCircle }] : []),
    ...(isOperator ? [{ to: '/manage', label: 'Manage', icon: Settings }] : []),
  ]
}

/** "GOVERNANCE" pill that sits beside the wordmark. */
function GovernancePill() {
  return (
    <span className="rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-primary dark:bg-algo-teal/15 dark:text-algo-teal">
      Governance
    </span>
  )
}

function ThemeToggle({ showLabel = false }: { showLabel?: boolean }) {
  const { theme, toggle } = useTheme()
  const label = theme === 'dark' ? 'Light mode' : 'Dark mode'
  const ariaLabel = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'
  const icon = theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />
  if (showLabel) {
    return (
      <Button variant="ghost" className="w-full justify-start gap-2 px-2" onClick={toggle} aria-label={ariaLabel}>
        {icon}
        <span className="text-sm font-normal text-muted-foreground">{label}</span>
      </Button>
    )
  }
  return (
    <Button variant="ghost" size="icon" className="size-8" onClick={toggle} aria-label={ariaLabel} title={label}>
      {icon}
    </Button>
  )
}

function RefreshButton({ showLabel = false }: { showLabel?: boolean }) {
  const queryClient = useQueryClient()
  const [refreshing, setRefreshing] = useState(false)

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      await queryClient.invalidateQueries()
    } finally {
      setRefreshing(false)
    }
  }

  if (showLabel) {
    return (
      <Button
        variant="ghost"
        className="w-full justify-start gap-2 px-2"
        onClick={handleRefresh}
        disabled={refreshing}
        aria-label="Reload data"
      >
        <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />
        <span className="text-sm font-normal text-muted-foreground">Reload data</span>
      </Button>
    )
  }
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-8"
      onClick={handleRefresh}
      disabled={refreshing}
      aria-label="Reload data"
      title="Reload data"
    >
      <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />
      <span className="sr-only">Reload data</span>
    </Button>
  )
}

/** Mobile-only drawer with the same nav entries (opened from the top-bar hamburger). */
function AppSidebar() {
  const location = useLocation()
  const navItems = useNavItems()

  return (
    <Sidebar>
      <SidebarHeader>
        <Link to="/" className="flex items-center gap-2 px-2 py-1">
          <AlgorandLogo className="text-primary size-6" />
          <span className="text-lg text-primary font-bold">Governance</span>
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map(({ to, label, icon: Icon }) => {
                const active = location.pathname.startsWith(to)
                return (
                  <SidebarMenuItem key={to}>
                    <SidebarMenuButton asChild isActive={active} tooltip={label}>
                      <Link to={to}>
                        <Icon />
                        <span>{label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="gap-2">
        <ThemeToggle showLabel />
        <RefreshButton showLabel />
        <TopBarAccount fullWidth />
      </SidebarFooter>
    </Sidebar>
  )
}

/** Desktop chrome: wordmark + GOVERNANCE pill, text nav, account control. */
function DesktopTopBar() {
  const location = useLocation()
  const navItems = useNavItems()

  return (
    <header className="hidden border-b border-border md:block">
      <div className="mx-auto flex h-[60px] w-full max-w-[1232px] items-center justify-between px-7">
        <div className="flex items-center gap-3.5">
          <Link to="/" className="flex items-center gap-2 text-foreground">
            <AlgorandLogo className="size-6" />
            <span className="font-display text-xl font-bold">Algorand</span>
          </Link>
          <GovernancePill />
        </div>
        <nav className="flex items-center gap-[22px] text-sm">
          {navItems.map(({ to, label }) => {
            const active = location.pathname.startsWith(to)
            return (
              <Link
                key={to}
                to={to}
                className={cn(
                  'transition-colors hover:text-foreground',
                  active ? 'font-semibold text-foreground' : 'text-muted-foreground',
                )}
              >
                {label}
              </Link>
            )
          })}
          <div className="flex items-center gap-1.5">
            <RefreshButton />
            <ThemeToggle />
          </div>
          <TopBarAccount />
        </nav>
      </div>
    </header>
  )
}

/** Compact bar for mobile: hamburger (opens drawer) + wordmark + account control. */
function MobileTopBar() {
  return (
    <header className="flex h-14 items-center justify-between gap-2 border-b border-border px-4 md:hidden">
      <div className="flex items-center gap-2">
        <SidebarTrigger aria-label="Open menu" />
        <Link to="/" className="flex items-center gap-2 text-foreground">
          <AlgorandLogo className="size-6" />
          <GovernancePill />
        </Link>
      </div>
      <TopBarAccount />
    </header>
  )
}

export default function Layout() {
  const isMobile = useIsMobile()

  return (
    <SidebarProvider>
      {isMobile && <AppSidebar />}
      <SidebarInset>
        <MobileTopBar />
        <DesktopTopBar />
        <div className="mx-auto w-full max-w-[1232px] flex-1 px-4 py-7 sm:px-7">
          <Suspense fallback={<Skeleton className="h-64 w-full" />}>
            <Outlet />
          </Suspense>
        </div>
        <Footer />
      </SidebarInset>
    </SidebarProvider>
  )
}
