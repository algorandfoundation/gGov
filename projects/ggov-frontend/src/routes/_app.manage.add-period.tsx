import { createFileRoute } from '@tanstack/react-router'
import AddPeriod from '@/components/pages/manage/AddPeriod'

export const Route = createFileRoute('/_app/manage/add-period')({
  ssr: false,
  component: AddPeriod,
})
