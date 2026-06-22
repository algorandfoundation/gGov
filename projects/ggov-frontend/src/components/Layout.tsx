import { Suspense, useState } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useWallet } from '@txnlab/use-wallet-react'
import { useGlobalState } from '@/hooks/queries'
import { useTheme } from '@/hooks/useTheme'
import { useIsMobile } from '@/hooks/use-mobile'
import Brand from '@/components/Brand'
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
import { Vote, Users, UserCircle, Settings, BookOpen, Sun, Moon, RefreshCw, type LucideIcon } from 'lucide-react'

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
    { to: '/docs', label: 'Docs', icon: BookOpen },
  ]
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
        <Brand className="px-2 py-1" />
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

/** Desktop chrome: brand lockup + reload, text nav, account control. */
function DesktopTopBar() {
  const location = useLocation()
  const navItems = useNavItems()

  return (
    <header className="hidden border-b border-border md:block">
      <div className="mx-auto flex h-[60px] w-full max-w-[1232px] items-center justify-between px-7">
        <div className="flex items-center gap-3">
          <Brand />
          <RefreshButton />
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
          <ThemeToggle />
          <TopBarAccount />
        </nav>
      </div>
    </header>
  )
}

/** Compact bar for mobile: hamburger (opens drawer) + brand lockup + account control. */
function MobileTopBar() {
  return (
    <header className="flex h-14 items-center justify-between gap-2 border-b border-border px-4 md:hidden">
      <div className="flex items-center gap-2">
        <SidebarTrigger aria-label="Open menu" />
        <Brand />
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
