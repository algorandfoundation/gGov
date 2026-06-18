import { Suspense } from 'react'
import { Link, Outlet } from 'react-router-dom'
import Footer from '@/components/Footer'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ArrowRight } from 'lucide-react'

function AlgorandLogo({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24" className={className}>
      <path fill="currentColor" d="m6.142 21 8.221-14.227.99 3.683L9.268 21h3.115l3.953-6.844L18.181 21h2.792l-2.729-10.166L20.18 7.2h-2.836L16.138 3h-2.72L3.028 21z" />
    </svg>
  )
}

/**
 * Standalone chrome for the landing page: no sidebar and no app header, just a
 * brand mark and a primary "Launch" button at the top right, with the shared
 * footer kept at the bottom.
 */
export default function LandingLayout() {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex items-center justify-between px-4 py-4 md:px-6">
        <Link to="/" className="flex items-center gap-2">
          <AlgorandLogo className="text-primary size-6" />
          <span className="text-lg text-primary font-bold">Governance</span>
        </Link>
        <Button asChild>
          <Link to="/vote">
            Launch
            <ArrowRight />
          </Link>
        </Button>
      </header>
      <main className="flex-1 px-4 py-6">
        <Suspense fallback={<Skeleton className="h-64 w-full" />}>
          <Outlet />
        </Suspense>
      </main>
      <Footer />
    </div>
  )
}
