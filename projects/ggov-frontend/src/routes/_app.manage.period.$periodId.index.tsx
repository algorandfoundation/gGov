import { createFileRoute } from '@tanstack/react-router'
import ManagePeriodDetail from '@/components/pages/manage/ManagePeriodDetail'

export const Route = createFileRoute('/_app/manage/period/$periodId/')({
  ssr: false,
  component: ManagePeriodDetail,
})
