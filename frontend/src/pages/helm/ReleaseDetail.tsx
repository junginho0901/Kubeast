import { useCallback, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, FlaskConical, Loader2, Trash2 } from 'lucide-react'
import { api } from '@/services/api'
import { usePermission } from '@/hooks/usePermission'
import { useAIContext } from '@/hooks/useAIContext'
import { useHelmWatchList, type HelmWatchEvent } from '@/services/useHelmWatchList'
import OverviewTab from './tabs/OverviewTab'
import ValuesTab from './tabs/ValuesTab'
import ManifestTab from './tabs/ManifestTab'
import NotesTab from './tabs/NotesTab'
import HistoryTab from './tabs/HistoryTab'
import ResourcesTab from './tabs/ResourcesTab'
import UninstallModal from './modals/UninstallModal'
import TestResultModal from './modals/TestResultModal'

type TabKey = 'overview' | 'values' | 'manifest' | 'notes' | 'history' | 'resources'

export default function HelmReleaseDetailPage() {
  const { t } = useTranslation()
  const { has } = usePermission()
  const { namespace = '', name = '' } = useParams<{ namespace: string; name: string }>()
  const [tab, setTab] = useState<TabKey>('overview')
  const [uninstallOpen, setUninstallOpen] = useState(false)
  const [testOpen, setTestOpen] = useState(false)

  const queryClient = useQueryClient()

  const detailQuery = useQuery({
    queryKey: ['helm-release', namespace, name],
    queryFn: () => api.helm.getRelease(namespace, name),
    enabled: !!namespace && !!name,
    // The watch below invalidates this query on any release event, so
    // we don't need a polling fallback. staleTime keeps the data warm
    // until invalidate fires.
    staleTime: Infinity,
  })

  // Watch the namespace's Helm releases and invalidate dependent queries
  // when this specific release changes (rollback / upgrade / uninstall).
  // We don't patch a list cache here — pass queryKey: null and rely on
  // onEvent to drive react-query invalidation instead.
  const handleHelmEvent = useCallback(
    (event: HelmWatchEvent) => {
      const obj = event.object
      if (obj?.name !== name || obj?.namespace !== namespace) return
      queryClient.invalidateQueries({ queryKey: ['helm-release', namespace, name] })
      queryClient.invalidateQueries({ queryKey: ['helm-section', namespace, name] })
      queryClient.invalidateQueries({ queryKey: ['helm-history', namespace, name] })
      queryClient.invalidateQueries({ queryKey: ['helm-resources', namespace, name] })
      // The list page (if mounted in another tab/route) shares this key
      // and will pick up the change via its own useHelmWatchList — but
      // invalidating here as well covers the case where the user lands
      // on the detail page first.
      queryClient.invalidateQueries({ queryKey: ['helm-releases'] })
    },
    [namespace, name, queryClient],
  )

  useHelmWatchList({
    cluster: 'default',
    namespace: namespace || undefined,
    enabled: !!namespace && !!name,
    queryKey: null,
    onEvent: handleHelmEvent,
  })

  // 활성 탭 별로 상세 데이터를 함께 fetch — TanStack Query 가 자식 탭 컴포넌트와
  // 같은 queryKey 를 공유하므로 중복 호출 없음. LLM overlay 에 넘기는 용도.
  const sectionQuery = useQuery({
    queryKey: ['helm-section', namespace, name, tab as 'values' | 'manifest' | 'notes'],
    queryFn: () => api.helm.getSection(namespace, name, tab as 'values' | 'manifest' | 'notes'),
    enabled: !!namespace && !!name && (tab === 'values' || tab === 'manifest' || tab === 'notes'),
  })
  const historyQuery = useQuery({
    queryKey: ['helm-history', namespace, name],
    queryFn: () => api.helm.getHistory(namespace, name),
    enabled: !!namespace && !!name && tab === 'history',
  })
  const resourcesQuery = useQuery({
    queryKey: ['helm-resources', namespace, name],
    queryFn: () => api.helm.getResources(namespace, name),
    enabled: !!namespace && !!name && tab === 'resources',
  })

  // 플로팅 AI 위젯용 스냅샷 (현재 활성 탭 기준)
  // active_tab 에 따라 추가 데이터 (manifest/values/notes/history/resources) 를
  // 8KB cap 으로 자른 뒤 함께 전달.
  const aiSnapshot = useMemo(() => {
    const rel = detailQuery.data
    if (!rel) return null
    const status = String(rel.status ?? '')
    const prefix = /fail|error/i.test(status) ? '⚠️ ' : ''

    const TAB_CAP = 8 * 1024
    const truncate = (s: unknown): string | undefined => {
      if (typeof s !== 'string' || !s) return undefined
      return s.length > TAB_CAP ? s.slice(0, TAB_CAP) + '\n... (truncated)' : s
    }

    let tabContent: Record<string, unknown> | undefined
    if (tab === 'values' || tab === 'manifest' || tab === 'notes') {
      const text = (sectionQuery.data as any)?.content
      const yaml = truncate(text)
      if (yaml) tabContent = { [`${tab}_text`]: yaml }
    } else if (tab === 'history') {
      const items = Array.isArray(historyQuery.data) ? historyQuery.data : []
      tabContent = {
        history: items.slice(0, 20).map((h: any) => ({
          revision: h.revision,
          updated: h.updated,
          status: h.status,
          chart: h.chart,
          app_version: h.app_version,
          description: h.description,
        })),
      }
    } else if (tab === 'resources') {
      const items = Array.isArray(resourcesQuery.data) ? resourcesQuery.data : []
      tabContent = {
        resources: items.slice(0, 30).map((r) => ({
          kind: r.kind,
          api_version: r.apiVersion,
          name: r.name,
          namespace: r.namespace,
        })),
        resources_total: items.length,
      }
    }

    return {
      source: 'base' as const,
      summary: `${prefix}Helm Release ${rel.name} (${rel.namespace}) · rev ${rel.revision} · ${status} · 탭: ${tab}`,
      data: {
        kind: 'HelmRelease',
        name: rel.name,
        namespace: rel.namespace,
        revision: rel.revision,
        status,
        chart: rel.chart,
        chart_version: rel.chartVersion,
        app_version: rel.appVersion,
        active_tab: tab,
        ...(tabContent ?? {}),
      },
    }
  }, [detailQuery.data, tab, sectionQuery.data, historyQuery.data, resourcesQuery.data])

  useAIContext(aiSnapshot, [aiSnapshot])

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

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-white">{rel.name}</h1>
          <p className="text-slate-400 text-sm mt-1">
            {rel.namespace} · {rel.chart}@{rel.chartVersion} · rev {rel.revision}
          </p>
        </div>
        <div className="flex gap-2">
          {has('resource.helm.test') && (
            <button
              type="button"
              onClick={() => setTestOpen(true)}
              className="inline-flex items-center gap-1.5 rounded border border-slate-600 bg-slate-800 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-700"
            >
              <FlaskConical className="w-4 h-4" />
              {t('helmReleaseDetail.test.button')}
            </button>
          )}
          {has('resource.helm.uninstall') && (
            <button
              type="button"
              onClick={() => setUninstallOpen(true)}
              className="inline-flex items-center gap-1.5 rounded border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-sm text-red-200 hover:bg-red-500/20"
            >
              <Trash2 className="w-4 h-4" />
              {t('helmReleaseDetail.uninstall.button')}
            </button>
          )}
        </div>
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
      {tab === 'values' && <ValuesTab namespace={namespace} name={name} />}
      {tab === 'manifest' && <ManifestTab namespace={namespace} name={name} />}
      {tab === 'notes' && <NotesTab namespace={namespace} name={name} />}
      {tab === 'history' && <HistoryTab namespace={namespace} name={name} currentRevision={rel.revision} />}
      {tab === 'resources' && <ResourcesTab namespace={namespace} name={name} />}

      {uninstallOpen && (
        <UninstallModal
          namespace={namespace}
          name={name}
          onClose={() => setUninstallOpen(false)}
        />
      )}

      {testOpen && (
        <TestResultModal
          namespace={namespace}
          name={name}
          onClose={() => setTestOpen(false)}
        />
      )}
    </div>
  )
}
