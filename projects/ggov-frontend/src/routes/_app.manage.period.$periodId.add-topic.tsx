import { createFileRoute } from '@tanstack/react-router'
import AddTopic from '@/components/pages/manage/AddTopic'

export const Route = createFileRoute('/_app/manage/period/$periodId/add-topic')({
  ssr: false,
  component: AddTopic,
})
