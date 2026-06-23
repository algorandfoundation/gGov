import { createFileRoute } from '@tanstack/react-router'
import ManagePeriods from '@/components/pages/manage/ManagePeriods'

export const Route = createFileRoute('/_app/manage/')({
  ssr: false,
  component: ManagePeriods,
})
