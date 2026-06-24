import { Suspense } from 'react'
import { Link, Outlet } from '@tanstack/react-router'
import Brand from '@/components/Brand'
import ThemeToggle from '@/components/ThemeToggle'
import Footer from '@/components/Footer'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ArrowRight } from 'lucide-react'

/**
 * Standalone chrome for the landing page: no sidebar and no app header, just a
 * brand mark on the left and a theme toggle beside a primary "Launch" button at
 * the top right, with the shared footer kept at the bottom.
 */
export default function LandingLayout() {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="px-4 py-4">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <Brand />
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Button asChild>
              <Link to="/vote">
                Launch
                <ArrowRight />
              </Link>
            </Button>
          </div>
        </div>
      </header>
      <main className="flex-1 px-4 py-6">
        <Suspense fallback={<Skeleton className="h-64 w-full" />}>
          <Outlet />
        </Suspense>
      </main>
      <Footer className="px-4" containerClassName="mx-auto max-w-6xl" />
    </div>
  )
}
