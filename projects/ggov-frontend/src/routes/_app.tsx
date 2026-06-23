import { createFileRoute } from '@tanstack/react-router'
import Layout from '@/components/Layout'

// App chrome (sidebar + header). SSR stays on so the chrome renders server-side
// for the SSR'd children (vote detail, committees); the interactive children opt
// out individually with `ssr: false`.
export const Route = createFileRoute('/_app')({
  component: Layout,
})
