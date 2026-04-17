import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { api, type HelmSection } from '@/services/api'

type TabKey = 'overview' | 'values' | 'manifest' | 'notes' | 'history' | 'resources'

// Tabs that map straight to a readable section (no edit path) share
// one generic component. Values is handled by its own tab because
// v1.1 adds inline editing + upgrade-with-preview there.
const READ_ONLY_SECTION: Record<'manifest' | 'notes', HelmSection> = {
  manifest: 'manifest',
  notes: 'notes',
}

export default function HelmReleaseDetailPage() {
  const { t } = useTranslation()
  const { namespace = '', name = '' } = useParams<{ namespace: string; name: string }>()
  const [tab, setTab] = useState<TabKey>('overview')

  const detailQuery = useQuery({
    queryKey: ['helm-release', namespace, name],
    queryFn: () => api.helm.getRelease(namespace, name),
    enabled: !!namespace && !!name,
  })

  if (detailQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-slate-400">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    )
  }

  if (detailQuery.isError || !detailQuery.data) {
    return (
      <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
        {t('helmReleaseDetail.error.notFound')}
      </div>
    )
  }

  const rel = detailQuery.data

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link
          to="/helm/releases"
          className="inline-flex items-center gap-1 text-sm text-slate-400 hover:text-white"
        >
          <ArrowLeft className="w-4 h-4" />
          Helm Releases
        </Link>
      </div>

      <div>
        <h1 className="text-3xl font-bold text-white">{rel.name}</h1>
        <p className="text-slate-400 text-sm mt-1">
          {rel.namespace} · {rel.chart}@{rel.chartVersion} · rev {rel.revision}
        </p>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-slate-700">
        {(['overview', 'values', 'manifest', 'notes', 'history', 'resources'] as TabKey[]).map((k) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`px-4 py-2 text-sm -mb-px border-b-2 transition ${
              tab === k
                ? 'border-primary-500 text-white'
                : 'border-transparent text-slate-400 hover:text-white'
            }`}
          >
            {t(`helmReleaseDetail.tabs.${k}`)}
          </button>
        ))}
      </div>

      {tab === 'overview' && <OverviewTab detail={rel} />}
      {tab === 'history' && <HistoryTab namespace={namespace} name={name} currentRevision={rel.revision} />}
      {tab === 'resources' && <ResourcesTab namespace={namespace} name={name} />}
      {tab === 'values' && <ValuesTab namespace={namespace} name={name} />}
      {(tab === 'manifest' || tab === 'notes') && (
        <SectionTab namespace={namespace} name={name} section={READ_ONLY_SECTION[tab]} />
      )}
    </div>
  )
}

function OverviewTab({ detail }: { detail: NonNullable<ReturnType<typeof api.helm.getRelease> extends Promise<infer R> ? R : never> }) {
  const { t } = useTranslation()
  const row = (label: string, value: string) => (
    <div className="flex flex-col gap-1 rounded-lg bg-slate-800/40 border border-slate-700 px-4 py-3">
      <span className="text-xs text-slate-400">{label}</span>
      <span className="text-sm text-white">{value || '-'}</span>
    </div>
  )
  const updated = detail.updated ? new Date(detail.updated).toLocaleString() : '-'
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {row(t('helmReleaseDetail.overview.chart'), detail.chart)}
      {row(t('helmReleaseDetail.overview.chartVersion'), detail.chartVersion)}
      {row(t('helmReleaseDetail.overview.appVersion'), detail.appVersion)}
      {row(t('helmReleaseDetail.overview.revision'), String(detail.revision))}
      {row(t('helmReleaseDetail.overview.status'), detail.status)}
      {row(t('helmReleaseDetail.overview.updated'), updated)}
      <div className="sm:col-span-2 lg:col-span-3">
        {row(t('helmReleaseDetail.overview.description'), detail.description)}
      </div>
    </div>
  )
}

function HistoryTab({ namespace, name, currentRevision }: { namespace: string; name: string; currentRevision: number }) {
  const { t } = useTranslation()

  const historyQuery = useQuery({
    queryKey: ['helm-history', namespace, name],
    queryFn: () => api.helm.getHistory(namespace, name),
    enabled: !!namespace && !!name,
  })

  if (historyQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-10 text-slate-400">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    )
  }

  const items = historyQuery.data ?? []
  if (items.length === 0) {
    return <div className="text-sm text-slate-400">{t('helmReleaseDetail.history.empty')}</div>
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-700">
      <table className="w-full text-sm">
        <thead className="bg-slate-800 text-slate-300 text-left">
          <tr>
            <th className="px-3 py-2">Revision</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Chart</th>
            <th className="px-3 py-2">App</th>
            <th className="px-3 py-2">Updated</th>
            <th className="px-3 py-2">Description</th>
          </tr>
        </thead>
        <tbody className="bg-slate-900/40 divide-y divide-slate-800">
          {items.map((h) => {
            const isCurrent = h.revision === currentRevision
            return (
              <tr key={h.revision} className="hover:bg-slate-800/60">
                <td className="px-3 py-2 text-white font-medium">
                  {h.revision}
                  {isCurrent && (
                    <span className="ml-2 rounded bg-primary-600/30 px-1.5 py-0.5 text-[10px] text-primary-200">
                      {t('helmReleaseDetail.history.current')}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-slate-300">{h.status}</td>
                <td className="px-3 py-2 text-slate-300">{h.chartVersion}</td>
                <td className="px-3 py-2 text-slate-300">{h.appVersion}</td>
                <td className="px-3 py-2 text-slate-400">
                  {h.updated ? new Date(h.updated).toLocaleString() : '-'}
                </td>
                <td className="px-3 py-2 text-slate-300">{h.description}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function ResourcesTab({ namespace, name }: { namespace: string; name: string }) {
  const { t } = useTranslation()
  const q = useQuery({
    queryKey: ['helm-resources', namespace, name],
    queryFn: () => api.helm.getResources(namespace, name),
    enabled: !!namespace && !!name,
  })

  if (q.isLoading) {
    return (
      <div className="flex items-center justify-center py-10 text-slate-400">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    )
  }

  const items = q.data ?? []
  if (items.length === 0) {
    return <div className="text-sm text-slate-400">{t('helmReleaseDetail.resources.empty')}</div>
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-700">
      <table className="w-full text-sm">
        <thead className="bg-slate-800 text-slate-300 text-left">
          <tr>
            <th className="px-3 py-2">Kind</th>
            <th className="px-3 py-2">API Version</th>
            <th className="px-3 py-2">Name</th>
            <th className="px-3 py-2">Namespace</th>
          </tr>
        </thead>
        <tbody className="bg-slate-900/40 divide-y divide-slate-800">
          {items.map((r, i) => (
            <tr key={`${r.kind}/${r.namespace ?? ''}/${r.name}/${i}`} className="hover:bg-slate-800/60">
              <td className="px-3 py-2 text-white">{r.kind}</td>
              <td className="px-3 py-2 text-slate-400">{r.apiVersion}</td>
              <td className="px-3 py-2 text-slate-300">{r.name}</td>
              <td className="px-3 py-2 text-slate-300">{r.namespace ?? '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ValuesTab({ namespace, name }: { namespace: string; name: string }) {
  const valuesQuery = useQuery({
    queryKey: ['helm-section', namespace, name, 'values'],
    queryFn: () => api.helm.getSection(namespace, name, 'values'),
    enabled: !!namespace && !!name,
  })

  if (valuesQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-10 text-slate-400">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    )
  }

  const current = valuesQuery.data?.content ?? ''
  return (
    <pre className="max-h-[60vh] overflow-auto rounded-lg bg-slate-900 border border-slate-700 px-4 py-3 text-xs text-slate-200 whitespace-pre">
      {current || '—'}
    </pre>
  )
}

function SectionTab({ namespace, name, section }: { namespace: string; name: string; section: HelmSection }) {
  const q = useQuery({
    queryKey: ['helm-section', namespace, name, section],
    queryFn: () => api.helm.getSection(namespace, name, section),
    enabled: !!namespace && !!name,
  })

  if (q.isLoading) {
    return (
      <div className="flex items-center justify-center py-10 text-slate-400">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    )
  }

  const content = q.data?.content ?? ''
  return (
    <pre className="max-h-[70vh] overflow-auto rounded-lg bg-slate-900 border border-slate-700 px-4 py-3 text-xs text-slate-200 whitespace-pre">
      {content || '—'}
    </pre>
  )
}
