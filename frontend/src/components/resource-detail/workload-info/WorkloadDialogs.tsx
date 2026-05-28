import { useTranslation } from 'react-i18next'
import { ModalOverlay } from '@/components/ModalOverlay'
import { fmtRel } from '../DetailCommon'

interface TriggerToast {
  type: 'success' | 'error'
  message: string
}

interface Props {
  triggerToast: TriggerToast | null
  triggerDialogOpen: boolean
  setTriggerDialogOpen: (open: boolean) => void
  triggerMut: { isPending: boolean; mutate: () => void }
  rollbackDialogOpen: boolean
  setRollbackDialogOpen: (open: boolean) => void
  rollbackMut: { isPending: boolean; mutate: (revision: number) => void }
  revisions: any
  selectedRevision: number | null
  setSelectedRevision: (revision: number | null) => void
}

export default function WorkloadDialogs({
  triggerToast,
  triggerDialogOpen,
  setTriggerDialogOpen,
  triggerMut,
  rollbackDialogOpen,
  setRollbackDialogOpen,
  rollbackMut,
  revisions,
  selectedRevision,
  setSelectedRevision,
}: Props) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, o?: Record<string, any>) => t(key, { defaultValue: fallback, ...o })

  return (
    <>
      {triggerToast && (
        <div
          className={`fixed bottom-4 right-4 z-50 px-4 py-2 rounded-lg text-sm shadow-lg ${
            triggerToast.type === 'success' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'
          }`}
        >
          {triggerToast.message}
        </div>
      )}

      {triggerDialogOpen && (
        <ModalOverlay onClose={() => { if (!triggerMut.isPending) setTriggerDialogOpen(false) }}>
          <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-white mb-3">{tr('cronjob.runNow', 'Run Now')}</h3>
            <p className="text-sm text-slate-300 mb-6">
              {tr('cronjob.runNowConfirm', 'Are you sure you want to trigger a manual job from this CronJob?')}
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setTriggerDialogOpen(false)}
                disabled={triggerMut.isPending}
                className="px-3 py-1.5 text-sm rounded border border-slate-600 text-slate-300 hover:bg-slate-800"
              >{tr('rollback.cancel', 'Cancel')}</button>
              <button
                onClick={() => triggerMut.mutate()}
                disabled={triggerMut.isPending}
                className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >{triggerMut.isPending ? '...' : tr('cronjob.runNow', 'Run Now')}</button>
            </div>
          </div>
        </ModalOverlay>
      )}

      {rollbackDialogOpen && (
        <ModalOverlay onClose={() => { if (!rollbackMut.isPending) setRollbackDialogOpen(false) }}>
          <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-6 w-full max-w-lg" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-white mb-3">{tr('rollback.title', 'Rollback')}</h3>
            <p className="text-sm text-slate-400 mb-4">{tr('rollback.selectRevision', 'Select a revision to rollback to')}</p>
            {!revisions ? (
              <p className="text-xs text-slate-400 py-4 text-center">Loading...</p>
            ) : revisions.length === 0 ? (
              <p className="text-xs text-slate-400 py-4 text-center">No revisions found</p>
            ) : (
              <div className="max-h-[300px] overflow-auto space-y-1">
                {revisions.map((rev: any) => (
                  <label
                    key={rev.revision}
                    className={`flex items-center gap-3 px-3 py-2 rounded cursor-pointer text-xs ${
                      rev.is_current ? 'opacity-50 cursor-not-allowed bg-slate-800/30' : 'hover:bg-slate-800/60'
                    } ${selectedRevision === rev.revision ? 'bg-blue-900/30 border border-blue-700' : 'border border-transparent'}`}
                  >
                    <input
                      type="radio"
                      name="revision"
                      value={rev.revision}
                      checked={selectedRevision === rev.revision}
                      disabled={rev.is_current}
                      onChange={() => setSelectedRevision(rev.revision)}
                      className="accent-blue-500"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-white font-medium">
                        {tr('rollback.revision', 'Revision')} {rev.revision}
                        {rev.is_current && <span className="ml-2 text-emerald-400">({tr('rollback.current', 'Current')})</span>}
                      </div>
                      {Array.isArray(rev.images) && rev.images.length > 0 && (
                        <div className="text-slate-400 truncate">{rev.images.join(', ')}</div>
                      )}
                      {rev.created_at && <div className="text-slate-500">{fmtRel(rev.created_at)}</div>}
                    </div>
                  </label>
                ))}
              </div>
            )}
            <div className="flex justify-end gap-3 mt-4">
              <button
                onClick={() => { setRollbackDialogOpen(false); setSelectedRevision(null) }}
                disabled={rollbackMut.isPending}
                className="px-3 py-1.5 text-sm rounded border border-slate-600 text-slate-300 hover:bg-slate-800"
              >{tr('rollback.cancel', 'Cancel')}</button>
              <button
                onClick={() => { if (selectedRevision != null) rollbackMut.mutate(selectedRevision) }}
                disabled={rollbackMut.isPending || selectedRevision == null}
                className="px-3 py-1.5 text-sm rounded bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50"
              >{rollbackMut.isPending ? '...' : tr('rollback.confirm', 'Rollback')}</button>
            </div>
          </div>
        </ModalOverlay>
      )}
    </>
  )
}
