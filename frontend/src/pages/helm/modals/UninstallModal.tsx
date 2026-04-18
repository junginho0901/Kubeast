import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { ModalOverlay } from '@/components/ModalOverlay'
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
