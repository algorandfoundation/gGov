import { createFileRoute } from '@tanstack/react-router'
import ManagePeriodDetail from '@/components/pages/manage/ManagePeriodDetail'

export const Route = createFileRoute('/_app/manage/period/$periodId/')({
  ssr: false,
  // The page has two faces: View renders on-chain state with no write affordances, Edit shows
  // the edit controls. Only `edit` is encoded in the URL; everything else falls back to View.
  validateSearch: (search: Record<string, unknown>): { mode?: 'edit' } =>
    search.mode === 'edit' ? { mode: 'edit' } : {},
  component: ManagePeriodDetail,
})
