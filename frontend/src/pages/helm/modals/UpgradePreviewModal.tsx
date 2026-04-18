import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { ModalOverlay } from '@/components/ModalOverlay'
import { api, type HelmUpgradeResponse } from '@/services/api'
import DiffView from './DiffView'

export default function UpgradePreviewModal({
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
          <DiffView diff={diff} />
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
