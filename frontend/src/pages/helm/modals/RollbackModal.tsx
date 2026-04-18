import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { ModalOverlay } from '@/components/ModalOverlay'
import { api, type HelmRollbackResponse } from '@/services/api'
import DiffView from './DiffView'

export default function RollbackModal({
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
          <DiffView diff={diff} />
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
