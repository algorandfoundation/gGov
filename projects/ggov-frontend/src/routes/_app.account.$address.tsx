import { createFileRoute } from '@tanstack/react-router'
import Account from '@/components/pages/vote/Account'

export const Route = createFileRoute('/_app/account/$address')({
  ssr: false,
  component: Account,
})
