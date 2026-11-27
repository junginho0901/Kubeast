import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { ModalOverlay } from '@/components/ModalOverlay'
import { useAIContext } from '@/hooks/useAIContext'
import { api, type HelmUninstallResponse, type HelmReleaseResource } from '@/services/api'

export default function UninstallModal({
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
  useAIContext({
    source: 'HelmUninstallModal',
    summary: `언인스톨 확인 창 — Helm 릴리스 ${namespace}/${name}`,
    data: { action: 'uninstall', release: name, namespace, keep_history: keepHistory, error: error ?? undefined },
  }, [namespace, name, keepHistory, error])

  const dryRunMutation = useMutation({
    mutationFn: () =>
      api.helm.uninstall(namespace, name, { keepHistory, dryRun: true }),
    onSuccess: (data) => {
      setPreview(data)
      setError(null)
    },
    onError: (err: any) => {
      setError(err?.response?.data?.detail ?? err?.message ?? t('helmReleaseDetail.uninstall.dryRunFailed', 'dry-run failed'))
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
      setError(err?.response?.data?.detail ?? err?.message ?? t('helmReleaseDetail.uninstall.uninstallFailed', 'uninstall failed'))
    },
  })

  // Re-run dry-run whenever keepHistory flips so the preview stays
  // accurate to the chosen option (`mutate` is referentially stable).
  const { mutate: runDryRun } = dryRunMutation
  useEffect(() => {
    runDryRun()
  }, [keepHistory, runDryRun])

  const resources: HelmReleaseResource[] = preview?.resources ?? []
  const loading = dryRunMutation.isPending
  const applying = applyMutation.isPending
  const nameMatches = typed === name

  return (
    <ModalOverlay onClose={applying ? () => undefined : onClose}>
      <div
        className="bg-slate-800 border border-hairline rounded-xl shadow-2xl p-5 w-full max-w-2xl max-h-[calc(100vh-2rem)] overflow-y-auto mx-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-ink mb-1 break-words">
          {t('helmReleaseDetail.uninstall.title', { name })}
        </h3>
        <p className="text-sm text-red-300 mb-4 break-words">
          {t('helmReleaseDetail.uninstall.warning', { count: resources.length })}
        </p>

        {loading ? (
          <div className="flex items-center justify-center py-6 text-slate-400">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        ) : error && !preview ? (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200 break-words">
            {error}
          </div>
        ) : (
          <div className="max-h-[40vh] overflow-auto rounded-lg border border-hairline bg-slate-900 text-xs">
            <table className="w-full">
              <thead className="bg-slate-800 text-slate-300 text-left sticky top-0">
                <tr>
                  <th className="px-2 py-1">{t('helmReleaseDetail.resources.col.kind', 'Kind')}</th>
                  <th className="px-2 py-1">{t('helmReleaseDetail.resources.col.name', 'Name')}</th>
                  <th className="px-2 py-1">{t('helmReleaseDetail.resources.col.namespace', 'Namespace')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline text-slate-300">
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
            className="rounded-sm border-slate-600"
          />
          {t('helmReleaseDetail.uninstall.keepHistory')}
        </label>

        <div className="mt-4">
          <label className="block text-xs font-semibold text-slate-400 mb-1">
            {t('helmReleaseDetail.uninstall.confirmLabel', { name })}
          </label>
          <input
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            disabled={applying}
            placeholder={name}
            className="w-full h-10 rounded-lg border border-control bg-slate-900 px-3 py-2 text-sm text-ink placeholder:text-slate-500 focus:border-red-500 focus-visible:ring-1 focus-visible:ring-red-500 outline-hidden"
            autoFocus
          />
        </div>

        {error && preview && (
          <p className="mt-3 text-sm text-red-300 break-words">{error}</p>
        )}

        <div className="flex flex-wrap justify-end gap-2 mt-4">
          <button
            type="button"
            onClick={onClose}
            disabled={applying}
            className="btn btn-secondary h-9 text-sm disabled:opacity-50"
          >
            {t('helmReleaseDetail.uninstall.cancel')}
          </button>
          <button
            type="button"
            onClick={() => applyMutation.mutate()}
            disabled={!nameMatches || applying || loading}
            className="btn h-9 text-sm bg-red-600 hover:bg-red-700 text-white disabled:opacity-40 inline-flex items-center gap-2"
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
