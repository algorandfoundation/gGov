import { useState } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useWallet } from '@txnlab/use-wallet-react'
import { useGlobalState } from '@/hooks/queries'
import { useTheme } from '@/hooks/useTheme'
import ConnectWallet from '@/components/ConnectWallet'
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
import { Separator } from '@/components/ui/separator'
import { Vote, Users, UserCircle, Settings, Sun, Moon, RefreshCw } from 'lucide-react'

function AlgorandLogo({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24" className={className}>
      <path fill="currentColor" d="m6.142 21 8.221-14.227.99 3.683L9.268 21h3.115l3.953-6.844L18.181 21h2.792l-2.729-10.166L20.18 7.2h-2.836L16.138 3h-2.72L3.028 21z" />
    </svg>
  )
}

function AppSidebar() {
  const location = useLocation()
  const { activeAddress } = useWallet()
  const { data: globalState } = useGlobalState()
  const { theme, toggle: toggleTheme } = useTheme()

  const isOperator = !!activeAddress && !!globalState?.operator && activeAddress === globalState.operator

  const navItems = [
    { to: '/', label: 'Vote', icon: Vote },
    { to: '/committees', label: 'Committees', icon: Users },
    ...(activeAddress
      ? [{ to: `/account/${activeAddress}`, label: 'My account', icon: UserCircle }]
      : []),
    ...(isOperator ? [{ to: '/manage', label: 'Manage', icon: Settings }] : []),
  ]

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
                const active = to === '/'
                  ? location.pathname === '/'
                  : location.pathname.startsWith(to)
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
      <SidebarFooter>
        <Button variant="ghost" size="sm" onClick={toggleTheme} className="w-full justify-start gap-2" aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
          {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
          <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
        </Button>
        <ConnectWallet />
      </SidebarFooter>
    </Sidebar>
  )
}

function RefreshButton() {
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

  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7"
      onClick={handleRefresh}
      disabled={refreshing}
      aria-label="Refresh data"
      title="Refresh data"
    >
      <RefreshCw className={refreshing ? 'animate-spin' : undefined} />
      <span className="sr-only">Refresh data</span>
    </Button>
  )
}

export default function Layout() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-12 items-center gap-2 border-b px-4">
          <SidebarTrigger aria-label="Toggle sidebar" />
          <RefreshButton />
          <Separator orientation="vertical" className="h-4" />
        </header>
        <main className="flex-1 px-4 py-6">
          <Outlet />
        </main>
        <Footer />
      </SidebarInset>
    </SidebarProvider>
  )
}
