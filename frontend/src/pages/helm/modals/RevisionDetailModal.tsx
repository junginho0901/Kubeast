import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { ModalOverlay } from '@/components/ModalOverlay'
import { api, type HelmSection } from '@/services/api'
import DiffView from './DiffView'

// RevisionDetailModal shows a single historic revision's manifest /
// values / notes, plus a "Diff vs current" toggle that reuses the
// diff API and diff2html renderer.
export default function RevisionDetailModal({
  namespace,
  name,
  revision,
  currentRevision,
  onClose,
}: {
  namespace: string
  name: string
  revision: number
  currentRevision: number
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<HelmSection | 'diff'>('manifest')
  // The diff tab renders against the currently deployed revision so
  // the user can instantly see "what would change if I rolled back".
  // Hidden when the viewed revision IS the current one.
  const showDiff = revision !== currentRevision

  return (
    <ModalOverlay onClose={onClose}>
      <div
        className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-6 w-full max-w-4xl mx-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-white mb-1">
          {t('helmReleaseDetail.revision.title', { rev: revision })}
        </h3>
        <p className="text-sm text-slate-400 mb-4">
          {namespace}/{name} — rev {revision}
          {revision === currentRevision && (
            <span className="ml-2 rounded bg-primary-600/30 px-1.5 py-0.5 text-[10px] text-primary-200">
              {t('helmReleaseDetail.history.current')}
            </span>
          )}
        </p>

        <div className="flex gap-1 border-b border-slate-700 mb-3">
          {(
            [
              ['manifest', t('helmReleaseDetail.tabs.manifest')],
              ['values', t('helmReleaseDetail.tabs.values')],
              ['notes', t('helmReleaseDetail.tabs.notes')],
              ...(showDiff ? [['diff', t('helmReleaseDetail.revision.diffVsCurrent')]] : []),
            ] as Array<[HelmSection | 'diff', string]>
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`px-3 py-1.5 text-xs -mb-px border-b-2 transition ${
                tab === id
                  ? 'border-primary-500 text-white'
                  : 'border-transparent text-slate-400 hover:text-white'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'diff' ? (
          <DiffPane namespace={namespace} name={name} from={revision} to={currentRevision} />
        ) : (
          <SectionPane namespace={namespace} name={name} revision={revision} section={tab} />
        )}

        <div className="flex justify-end mt-4">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-slate-300 hover:text-white border border-slate-600 rounded-lg hover:bg-slate-800"
          >
            {t('helmReleaseDetail.revision.close')}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}

function SectionPane({
  namespace,
  name,
  revision,
  section,
}: {
  namespace: string
  name: string
  revision: number
  section: HelmSection
}) {
  const q = useQuery({
    queryKey: ['helm-revision-section', namespace, name, revision, section],
    queryFn: () => api.helm.getRevisionSection(namespace, name, revision, section),
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
    <pre className="max-h-[60vh] overflow-auto rounded bg-slate-950 border border-slate-700 px-3 py-2 text-xs text-slate-200 whitespace-pre">
      {content || '—'}
    </pre>
  )
}

function DiffPane({
  namespace,
  name,
  from,
  to,
}: {
  namespace: string
  name: string
  from: number
  to: number
}) {
  const q = useQuery({
    queryKey: ['helm-revision-diff', namespace, name, from, to],
    queryFn: () => api.helm.diff(namespace, name, { from, to, section: 'manifest' }),
  })

  if (q.isLoading) {
    return (
      <div className="flex items-center justify-center py-10 text-slate-400">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    )
  }

  return <DiffView diff={q.data?.diff ?? ''} />
}
