import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, History as HistoryIcon, Loader2, Trash2 } from 'lucide-react'
import {
  api,
  type HelmSection,
  type HelmRollbackResponse,
  type HelmUninstallResponse,
  type HelmUpgradeResponse,
  type HelmReleaseResource,
} from '@/services/api'
import { ModalOverlay } from '@/components/ModalOverlay'
import { usePermission } from '@/hooks/usePermission'

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
  const { has } = usePermission()
  const { namespace = '', name = '' } = useParams<{ namespace: string; name: string }>()
  const [tab, setTab] = useState<TabKey>('overview')
  const [uninstallOpen, setUninstallOpen] = useState(false)

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

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-white">{rel.name}</h1>
          <p className="text-slate-400 text-sm mt-1">
            {rel.namespace} · {rel.chart}@{rel.chartVersion} · rev {rel.revision}
          </p>
        </div>
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

      {uninstallOpen && (
        <UninstallModal
          namespace={namespace}
          name={name}
          onClose={() => setUninstallOpen(false)}
        />
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
  const { has } = usePermission()
  const [rollbackTarget, setRollbackTarget] = useState<number | null>(null)

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

  const canRollback = has('resource.helm.rollback')

  return (
    <>
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
              <th className="px-3 py-2 w-px" />
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
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {/* The current revision has nothing to roll back to;
                        missing permission hides the button entirely
                        rather than showing a disabled one, matching how
                        delete buttons are gated elsewhere. */}
                    {!isCurrent && canRollback && (
                      <button
                        type="button"
                        onClick={() => setRollbackTarget(h.revision)}
                        className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-200 hover:bg-amber-500/20"
                      >
                        <HistoryIcon className="w-3 h-3" />
                        {t('helmReleaseDetail.rollback.button')}
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {rollbackTarget !== null && (
        <RollbackModal
          namespace={namespace}
          name={name}
          targetRevision={rollbackTarget}
          onClose={() => setRollbackTarget(null)}
        />
      )}
    </>
  )
}

function RollbackModal({
  namespace,
  name,
  targetRevision,
  onClose,
}: {
  namespace: string
  name: string
  targetRevision: number
  onClose: () => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [preview, setPreview] = useState<HelmRollbackResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Auto-run dry-run on mount so the user sees the diff immediately.
  // Keeping it as a mutation (not a query) mirrors the apply mutation
  // one-hop below and makes success/error handling symmetric.
  const dryRunMutation = useMutation({
    mutationFn: () =>
      api.helm.rollback(namespace, name, { revision: targetRevision, dryRun: true }),
    onSuccess: (data) => {
      setPreview(data)
      setError(null)
    },
    onError: (err: any) => {
      setError(err?.response?.data?.detail ?? err?.message ?? 'dry-run failed')
    },
  })

  const applyMutation = useMutation({
    mutationFn: () =>
      api.helm.rollback(namespace, name, { revision: targetRevision, dryRun: false }),
    onSuccess: () => {
      // Invalidate every query that depends on the release's revision
      // state. The list query is keyed by namespace only so we blow
      // away the whole helm-releases namespace rather than tracking
      // each key.
      queryClient.invalidateQueries({ queryKey: ['helm-release', namespace, name] })
      queryClient.invalidateQueries({ queryKey: ['helm-history', namespace, name] })
      queryClient.invalidateQueries({ queryKey: ['helm-releases'] })
      onClose()
    },
    onError: (err: any) => {
      setError(err?.response?.data?.detail ?? err?.message ?? 'rollback failed')
    },
  })

  // Fire the dry-run exactly once per mount. dryRunMutation is stable
  // across renders from react-query; the empty dep array is intentional.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    dryRunMutation.mutate()
  }, [])

  const diff = preview?.diff ?? ''
  const noChange = preview !== null && diff.trim() === ''
  const loading = dryRunMutation.isPending
  const applying = applyMutation.isPending

  return (
    <ModalOverlay onClose={applying ? () => undefined : onClose}>
      <div
        className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-6 w-full max-w-3xl mx-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-white mb-1">
          {t('helmReleaseDetail.rollback.title', { rev: targetRevision })}
        </h3>
        <p className="text-sm text-slate-400 mb-4">
          {t('helmReleaseDetail.rollback.subtitle', { ns: namespace, name })}
        </p>

        {loading ? (
          <div className="flex items-center justify-center py-10 text-slate-400">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        ) : error ? (
          <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            {error}
          </div>
        ) : noChange ? (
          <div className="rounded border border-slate-600 bg-slate-800/40 px-3 py-4 text-sm text-slate-300">
            {t('helmReleaseDetail.rollback.noChange')}
          </div>
        ) : (
          <pre className="max-h-[50vh] overflow-auto rounded bg-slate-950 border border-slate-700 px-3 py-2 text-xs text-slate-200 whitespace-pre">
            {diff}
          </pre>
        )}

        <div className="flex justify-end gap-2 mt-4">
          <button
            type="button"
            onClick={onClose}
            disabled={applying}
            className="px-4 py-2 text-sm text-slate-300 hover:text-white border border-slate-600 rounded-lg hover:bg-slate-800 disabled:opacity-50"
          >
            {t('helmReleaseDetail.rollback.cancel')}
          </button>
          <button
            type="button"
            onClick={() => applyMutation.mutate()}
            disabled={loading || applying || !!error}
            className="px-4 py-2 text-sm bg-amber-600 hover:bg-amber-700 text-white rounded-lg disabled:opacity-50 inline-flex items-center gap-2"
          >
            {applying && <Loader2 className="w-4 h-4 animate-spin" />}
            {applying
              ? t('helmReleaseDetail.rollback.applying')
              : t('helmReleaseDetail.rollback.apply')}
          </button>
        </div>
      </div>
    </ModalOverlay>
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

function ValuesTab({ namespace, name }: { namespace: string; name: string }) {
  const { t } = useTranslation()
  const { has } = usePermission()
  const canEdit = has('resource.helm.upgrade')

  const valuesQuery = useQuery({
    queryKey: ['helm-section', namespace, name, 'values'],
    queryFn: () => api.helm.getSection(namespace, name, 'values'),
    enabled: !!namespace && !!name,
  })

  // Local draft; entering edit mode seeds it from the last-known server
  // copy. We do not bind directly to the query data so a background
  // refetch can't stomp the user's in-progress edit.
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [preview, setPreview] = useState<HelmUpgradeResponse | null>(null)

  const current = valuesQuery.data?.content ?? ''

  const beginEdit = () => {
    setDraft(current)
    setEditing(true)
  }

  if (valuesQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-10 text-slate-400">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    )
  }

  if (!editing) {
    return (
      <div className="space-y-3">
        {canEdit && (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={beginEdit}
              className="inline-flex items-center gap-1.5 rounded border border-slate-600 bg-slate-800 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-700"
            >
              {t('helmReleaseDetail.upgrade.edit')}
            </button>
          </div>
        )}
        <pre className="max-h-[60vh] overflow-auto rounded-lg bg-slate-900 border border-slate-700 px-4 py-3 text-xs text-slate-200 whitespace-pre">
          {current || '—'}
        </pre>
      </div>
    )
  }

  return (
    <>
      <div className="space-y-3">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          className="w-full min-h-[40vh] max-h-[60vh] rounded-lg bg-slate-950 border border-slate-700 p-3 font-mono text-xs text-slate-100 focus:border-primary-500 outline-none"
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              setEditing(false)
              setDraft('')
            }}
            className="px-4 py-2 text-sm text-slate-300 hover:text-white border border-slate-600 rounded-lg hover:bg-slate-800"
          >
            {t('helmReleaseDetail.upgrade.cancel')}
          </button>
          <button
            type="button"
            disabled={draft === current}
            onClick={async () => {
              try {
                const r = await api.helm.upgradeValues(namespace, name, {
                  values: draft,
                  dryRun: true,
                })
                setPreview(r)
              } catch (err: any) {
                setPreview({
                  dryRun: true,
                  fromRevision: 0,
                  chartVersion: '',
                  diff: err?.response?.data?.detail ?? err?.message ?? 'dry-run failed',
                })
              }
            }}
            className="px-4 py-2 text-sm bg-primary-600 hover:bg-primary-700 text-white rounded-lg disabled:opacity-40"
          >
            {t('helmReleaseDetail.upgrade.preview')}
          </button>
        </div>
      </div>

      {preview && (
        <UpgradePreviewModal
          namespace={namespace}
          name={name}
          values={draft}
          preview={preview}
          onClose={() => setPreview(null)}
          onApplied={() => {
            setPreview(null)
            setEditing(false)
            setDraft('')
          }}
        />
      )}
    </>
  )
}

function UpgradePreviewModal({
  namespace,
  name,
  values,
  preview,
  onClose,
  onApplied,
}: {
  namespace: string
  name: string
  values: string
  preview: HelmUpgradeResponse
  onClose: () => void
  onApplied: () => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)

  const applyMutation = useMutation({
    mutationFn: () =>
      api.helm.upgradeValues(namespace, name, { values, dryRun: false }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['helm-release', namespace, name] })
      queryClient.invalidateQueries({ queryKey: ['helm-history', namespace, name] })
      queryClient.invalidateQueries({ queryKey: ['helm-section', namespace, name, 'values'] })
      queryClient.invalidateQueries({ queryKey: ['helm-section', namespace, name, 'manifest'] })
      queryClient.invalidateQueries({ queryKey: ['helm-releases'] })
      onApplied()
    },
    onError: (err: any) => {
      setError(err?.response?.data?.detail ?? err?.message ?? 'upgrade failed')
    },
  })

  const diff = preview.diff ?? ''
  const noChange = diff.trim() === ''
  const applying = applyMutation.isPending

  return (
    <ModalOverlay onClose={applying ? () => undefined : onClose}>
      <div
        className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-6 w-full max-w-3xl mx-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-white mb-1">
          {t('helmReleaseDetail.upgrade.title')}
        </h3>
        <p className="text-sm text-slate-400 mb-4">
          {t('helmReleaseDetail.upgrade.subtitle', { ns: namespace, name })}
        </p>

        {noChange ? (
          <div className="rounded border border-slate-600 bg-slate-800/40 px-3 py-4 text-sm text-slate-300">
            {t('helmReleaseDetail.upgrade.noChange')}
          </div>
        ) : (
          <pre className="max-h-[50vh] overflow-auto rounded bg-slate-950 border border-slate-700 px-3 py-2 text-xs text-slate-200 whitespace-pre">
            {diff}
          </pre>
        )}

        {error && <p className="mt-3 text-sm text-red-300">{error}</p>}

        <div className="flex justify-end gap-2 mt-4">
          <button
            type="button"
            onClick={onClose}
            disabled={applying}
            className="px-4 py-2 text-sm text-slate-300 hover:text-white border border-slate-600 rounded-lg hover:bg-slate-800 disabled:opacity-50"
          >
            {t('helmReleaseDetail.upgrade.cancel')}
          </button>
          <button
            type="button"
            onClick={() => applyMutation.mutate()}
            disabled={applying || noChange}
            className="px-4 py-2 text-sm bg-primary-600 hover:bg-primary-700 text-white rounded-lg disabled:opacity-40 inline-flex items-center gap-2"
          >
            {applying && <Loader2 className="w-4 h-4 animate-spin" />}
            {applying
              ? t('helmReleaseDetail.upgrade.applying')
              : t('helmReleaseDetail.upgrade.apply')}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}

function UninstallModal({
  namespace,
  name,
  onClose,
}: {
  namespace: string
  name: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [typed, setTyped] = useState('')
  const [keepHistory, setKeepHistory] = useState(false)
  const [preview, setPreview] = useState<HelmUninstallResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const dryRunMutation = useMutation({
    mutationFn: () =>
      api.helm.uninstall(namespace, name, { keepHistory, dryRun: true }),
    onSuccess: (data) => {
      setPreview(data)
      setError(null)
    },
    onError: (err: any) => {
      setError(err?.response?.data?.detail ?? err?.message ?? 'dry-run failed')
    },
  })

  const applyMutation = useMutation({
    mutationFn: () =>
      api.helm.uninstall(namespace, name, { keepHistory, dryRun: false }),
    onSuccess: () => {
      // Release is gone — pop the detail cache and route back to the
      // list. The list query invalidation makes the polled refetch
      // hide the row on its next tick.
      queryClient.removeQueries({ queryKey: ['helm-release', namespace, name] })
      queryClient.invalidateQueries({ queryKey: ['helm-releases'] })
      navigate('/helm/releases')
    },
    onError: (err: any) => {
      setError(err?.response?.data?.detail ?? err?.message ?? 'uninstall failed')
    },
  })

  // Re-run dry-run whenever keepHistory flips so the preview stays
  // accurate to the chosen option.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    dryRunMutation.mutate()
  }, [keepHistory])

  const resources: HelmReleaseResource[] = preview?.resources ?? []
  const loading = dryRunMutation.isPending
  const applying = applyMutation.isPending
  const nameMatches = typed === name

  return (
    <ModalOverlay onClose={applying ? () => undefined : onClose}>
      <div
        className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-6 w-full max-w-2xl mx-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-white mb-1">
          {t('helmReleaseDetail.uninstall.title', { name })}
        </h3>
        <p className="text-sm text-red-300/80 mb-4">
          {t('helmReleaseDetail.uninstall.warning', { count: resources.length })}
        </p>

        {loading ? (
          <div className="flex items-center justify-center py-6 text-slate-400">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        ) : error && !preview ? (
          <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            {error}
          </div>
        ) : (
          <div className="max-h-[40vh] overflow-auto rounded border border-slate-700 bg-slate-950 text-xs">
            <table className="w-full">
              <thead className="bg-slate-800 text-slate-300 text-left sticky top-0">
                <tr>
                  <th className="px-2 py-1">Kind</th>
                  <th className="px-2 py-1">Name</th>
                  <th className="px-2 py-1">Namespace</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800 text-slate-300">
                {resources.map((r, i) => (
                  <tr key={`${r.kind}/${r.namespace ?? ''}/${r.name}/${i}`}>
                    <td className="px-2 py-1">{r.kind}</td>
                    <td className="px-2 py-1">{r.name}</td>
                    <td className="px-2 py-1 text-slate-400">{r.namespace ?? '-'}</td>
                  </tr>
                ))}
                {resources.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-2 py-2 text-center text-slate-500">
                      —
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        <label className="mt-4 flex items-center gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={keepHistory}
            disabled={applying}
            onChange={(e) => setKeepHistory(e.target.checked)}
            className="rounded border-slate-600"
          />
          {t('helmReleaseDetail.uninstall.keepHistory')}
        </label>

        <div className="mt-4">
          <label className="block text-xs text-slate-400 mb-1">
            {t('helmReleaseDetail.uninstall.confirmLabel', { name })}
          </label>
          <input
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            disabled={applying}
            placeholder={name}
            className="w-full rounded border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-red-500 outline-none"
            autoFocus
          />
        </div>

        {error && preview && (
          <p className="mt-3 text-sm text-red-300">{error}</p>
        )}

        <div className="flex justify-end gap-2 mt-4">
          <button
            type="button"
            onClick={onClose}
            disabled={applying}
            className="px-4 py-2 text-sm text-slate-300 hover:text-white border border-slate-600 rounded-lg hover:bg-slate-800 disabled:opacity-50"
          >
            {t('helmReleaseDetail.uninstall.cancel')}
          </button>
          <button
            type="button"
            onClick={() => applyMutation.mutate()}
            disabled={!nameMatches || applying || loading}
            className="px-4 py-2 text-sm bg-red-600 hover:bg-red-700 text-white rounded-lg disabled:opacity-40 inline-flex items-center gap-2"
          >
            {applying && <Loader2 className="w-4 h-4 animate-spin" />}
            {applying
              ? t('helmReleaseDetail.uninstall.applying')
              : t('helmReleaseDetail.uninstall.apply')}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}
