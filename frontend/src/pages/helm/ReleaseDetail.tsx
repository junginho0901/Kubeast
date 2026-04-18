import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, FlaskConical, Loader2, Trash2 } from 'lucide-react'
import { api } from '@/services/api'
import { usePermission } from '@/hooks/usePermission'
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
