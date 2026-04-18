import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { History as HistoryIcon, Loader2 } from 'lucide-react'
import { api } from '@/services/api'
import { usePermission } from '@/hooks/usePermission'
import RollbackModal from '../modals/RollbackModal'
import RevisionDetailModal from '../modals/RevisionDetailModal'

export default function HistoryTab({
  namespace,
  name,
  currentRevision,
}: {
  namespace: string
  name: string
  currentRevision: number
}) {
  const { t } = useTranslation()
  const { has } = usePermission()
  const [rollbackTarget, setRollbackTarget] = useState<number | null>(null)
  const [inspectTarget, setInspectTarget] = useState<number | null>(null)

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
                <tr
                  key={h.revision}
                  className="hover:bg-slate-800/60 cursor-pointer"
                  onClick={() => setInspectTarget(h.revision)}
                >
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
                    {!isCurrent && canRollback && (
                      <button
                        type="button"
                        onClick={(e) => {
                          // Stop the row's onClick from opening the
                          // inspect modal underneath the rollback one.
                          e.stopPropagation()
                          setRollbackTarget(h.revision)
                        }}
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

      {inspectTarget !== null && (
        <RevisionDetailModal
          namespace={namespace}
          name={name}
          revision={inspectTarget}
          currentRevision={currentRevision}
          onClose={() => setInspectTarget(null)}
        />
      )}
    </>
  )
}
