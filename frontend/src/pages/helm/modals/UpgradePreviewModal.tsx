import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { ModalOverlay } from '@/components/ModalOverlay'
import { useAIContext } from '@/hooks/useAIContext'
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
      setError(err?.response?.data?.detail ?? err?.message ?? t('helmReleaseDetail.upgrade.upgradeFailed', 'upgrade failed'))
    },
  })

  const diff = preview.diff ?? ''
  const noDiff = diff.trim() === ''
  const changedMasked = preview.changed_masked ?? []
  const noChange = noDiff && !preview.values_changed
  const applying = applyMutation.isPending
  const hiddenPart = changedMasked.length > 0 ? `, 새 값을 쓰거나 지운 가려진 값: ${changedMasked.join(', ')}` : ''
  const whatChanges = noChange ? '바뀌는 것 없음' : `${noDiff ? 'manifest 차이는 없고 values가 바뀜' : 'manifest 차이 있음'}${hiddenPart}`

  useAIContext(preview.failed ? {
    source: 'HelmUpgradePreview',
    summary: `Helm 릴리스 ${namespace}/${name} 업그레이드 미리보기 실패 — 적용할 것 없음: ${preview.failed}`,
    data: { release: name, namespace, diff: '', preview_error: preview.failed },
  } : {
    source: 'HelmUpgradePreview',
    summary: `Helm 릴리스 ${namespace}/${name} 업그레이드 미리보기 — 리비전 ${preview.fromRevision}에서, ${whatChanges}`,
    data: { release: name, namespace, from_revision: preview.fromRevision, chart_version: preview.chartVersion, diff: diff.slice(0, 4096), kept_masked: preview.kept_masked, changed_masked: preview.changed_masked, values_changed: preview.values_changed, error: error ?? undefined },
  }, [namespace, name, preview, diff, whatChanges, error])

  return (
    <ModalOverlay onClose={applying ? () => undefined : onClose}>
      <div
        className="bg-slate-800 border border-hairline rounded-xl shadow-2xl p-5 w-full max-w-3xl max-h-[calc(100vh-2rem)] overflow-y-auto mx-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-ink mb-1">
          {t('helmReleaseDetail.upgrade.title')}
        </h3>
        <p className="text-sm text-slate-400 mb-4 break-words">
          {t('helmReleaseDetail.upgrade.subtitle', { namespace, name })}
        </p>
        {!!preview.kept_masked?.length && (
          <p className="text-sm text-slate-400 mb-4 break-words" data-testid="helm-upgrade-kept-masked">
            {t('helmReleaseDetail.upgrade.keptMasked', { names: preview.kept_masked.join(', ') })}
          </p>
        )}
        {changedMasked.length > 0 && (
          <p className="text-sm text-slate-400 mb-4 break-words" data-testid="helm-upgrade-changed-masked">
            {t('helmReleaseDetail.upgrade.changedMasked', { names: changedMasked.join(', ') })}
          </p>
        )}

        {preview.failed ? (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200 whitespace-pre-wrap break-words" data-testid="helm-upgrade-preview-failed">{preview.failed}</div>
        ) : noDiff ? (
          <div className="rounded-lg border border-hairline bg-slate-900/40 px-3 py-4 text-sm text-slate-300">
            {noChange ? t('helmReleaseDetail.upgrade.noChange') : t('helmReleaseDetail.upgrade.noDiffValuesChange')}
          </div>
        ) : (
          <DiffView diff={diff} />
        )}

        {error && <p className="mt-3 text-sm text-red-300 break-words">{error}</p>}

        <div className="flex flex-wrap justify-end gap-2 mt-4">
          <button
            type="button"
            onClick={onClose}
            disabled={applying}
            className="btn btn-secondary h-9 text-sm disabled:opacity-50"
          >
            {t('helmReleaseDetail.upgrade.cancel')}
          </button>
          <button
            type="button"
            onClick={() => applyMutation.mutate()}
            disabled={applying || noChange || !!preview.failed}
            className="btn btn-primary h-9 text-sm disabled:opacity-40 inline-flex items-center gap-2"
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
