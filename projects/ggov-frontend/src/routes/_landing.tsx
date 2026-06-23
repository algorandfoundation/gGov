import { createFileRoute } from '@tanstack/react-router'
import LandingLayout from '@/components/LandingLayout'

// Landing chrome (no sidebar). Client-only — the marketing/home view has no
// server-rendered data and depends on no request context.
export const Route = createFileRoute('/_landing')({
  ssr: false,
  component: LandingLayout,
})
