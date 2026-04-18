import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type HelmReleaseDetail } from '@/services/api'

// Overview card grid — minimal release metadata. Release-owned resource
// and image counts are rendered in OverviewCountsCard which fires its
// own lazy query; keeping the two components separate means the main
// overview renders instantly and counts stream in when ready.
export default function OverviewTab({ detail }: { detail: HelmReleaseDetail }) {
  const { t } = useTranslation()

  // Counts come from separate endpoints; fire both in parallel and let
  // the cards render "…" while they resolve. No spinners — the metadata
  // above is useful on its own and the counts stream in.
  const resourcesQuery = useQuery({
    queryKey: ['helm-resources', detail.namespace, detail.name],
    queryFn: () => api.helm.getResources(detail.namespace, detail.name),
    enabled: !!detail.namespace && !!detail.name,
  })
  const imagesQuery = useQuery({
    queryKey: ['helm-images', detail.namespace, detail.name],
    queryFn: () => api.helm.getImages(detail.namespace, detail.name),
    enabled: !!detail.namespace && !!detail.name,
  })

  const row = (label: string, value: string) => (
    <div className="flex flex-col gap-1 rounded-lg bg-slate-800/40 border border-slate-700 px-4 py-3">
      <span className="text-xs text-slate-400">{label}</span>
      <span className="text-sm text-white">{value || '-'}</span>
    </div>
  )
  const countRow = (label: string, pending: boolean, value: number) => (
    <div className="flex flex-col gap-1 rounded-lg bg-slate-800/40 border border-slate-700 px-4 py-3">
      <span className="text-xs text-slate-400">{label}</span>
      <span className="text-lg font-semibold text-white">{pending ? '…' : value}</span>
    </div>
  )

  const updated = detail.updated ? new Date(detail.updated).toLocaleString() : '-'
  const resourceCount = resourcesQuery.data?.length ?? 0
  const imageCount = imagesQuery.data?.length ?? 0

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {row(t('helmReleaseDetail.overview.chart'), detail.chart)}
        {row(t('helmReleaseDetail.overview.chartVersion'), detail.chartVersion)}
        {row(t('helmReleaseDetail.overview.appVersion'), detail.appVersion)}
        {row(t('helmReleaseDetail.overview.revision'), String(detail.revision))}
        {row(t('helmReleaseDetail.overview.status'), detail.status)}
        {row(t('helmReleaseDetail.overview.updated'), updated)}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {row(t('helmReleaseDetail.overview.namespace'), detail.namespace)}
        {countRow(
          t('helmReleaseDetail.overview.resourceCount'),
          resourcesQuery.isLoading,
          resourceCount,
        )}
        {countRow(
          t('helmReleaseDetail.overview.imageCount'),
          imagesQuery.isLoading,
          imageCount,
        )}
      </div>

      {row(t('helmReleaseDetail.overview.description'), detail.description)}
    </div>
  )
}
