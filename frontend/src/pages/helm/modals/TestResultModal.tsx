import { useEffect, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { CheckCircle, Loader2, XCircle } from 'lucide-react'
import { ModalOverlay } from '@/components/ModalOverlay'
import { api, type HelmTestResponse } from '@/services/api'

// Runs helm test on the release on mount, then renders a per-hook
// status list. Kept lean — this is a diagnostic surface, not a
// long-running pipeline view, so we don't stream hook logs.
export default function TestResultModal({
  namespace,
  name,
  onClose,
}: {
  namespace: string
  name: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [result, setResult] = useState<HelmTestResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const runMutation = useMutation({
    mutationFn: () => api.helm.test(namespace, name),
    // Go marshals an empty slice as JSON null, so coerce hooks to [] here
    // to keep the render paths from tripping over `null.length`.
    onSuccess: (data) => setResult({ ...data, hooks: data.hooks ?? [] }),
    onError: (err: any) => {
      // A failing helm test still returns a response body shaped like
      // HelmTestResponse; surface both the error and any hook details
      // that made it through.
      const body = err?.response?.data
      if (body && Array.isArray(body.hooks)) {
        setResult(body as HelmTestResponse)
      }
      setError(err?.response?.data?.detail ?? err?.message ?? 'test failed')
    },
  })

  // Trigger on mount. Running helm test is itself a side-effect (spawns
  // test pods in the cluster), so we do it only when the user opens
  // the modal — never on background refetch.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    runMutation.mutate()
  }, [])

  const running = runMutation.isPending

  return (
    <ModalOverlay onClose={onClose}>
      <div
        className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-6 w-full max-w-2xl mx-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-white mb-1">
          {t('helmReleaseDetail.test.title', { name })}
        </h3>
        <p className="text-sm text-slate-400 mb-4">
          {t('helmReleaseDetail.test.subtitle')}
        </p>

        {running ? (
          <div className="flex items-center gap-2 py-8 justify-center text-slate-400">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-sm">{t('helmReleaseDetail.test.running')}</span>
          </div>
        ) : result && result.hooks.length === 0 ? (
          <div className="rounded border border-slate-600 bg-slate-800/40 px-3 py-4 text-sm text-slate-300">
            {t('helmReleaseDetail.test.noHooks')}
          </div>
        ) : result ? (
          <div className="space-y-2">
            <div
              className={`rounded px-3 py-2 text-sm ${
                result.success
                  ? 'bg-emerald-500/15 text-emerald-200 border border-emerald-500/30'
                  : 'bg-red-500/15 text-red-200 border border-red-500/30'
              }`}
            >
              {result.success
                ? t('helmReleaseDetail.test.passed')
                : t('helmReleaseDetail.test.failed')}
            </div>
            <ul className="rounded border border-slate-700 divide-y divide-slate-800 text-sm">
              {result.hooks.map((h) => (
                <li key={h.name} className="flex items-center gap-3 px-3 py-2">
                  {h.failed ? (
                    <XCircle className="w-4 h-4 text-red-400 shrink-0" />
                  ) : (
                    <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0" />
                  )}
                  <span className="text-white truncate">{h.name}</span>
                  <span className="text-xs text-slate-400 ml-auto">{h.phase}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : error ? (
          <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            {error}
          </div>
        ) : null}

        <div className="flex justify-end mt-4">
          <button
            type="button"
            onClick={onClose}
            disabled={running}
            className="px-4 py-2 text-sm text-slate-300 hover:text-white border border-slate-600 rounded-lg hover:bg-slate-800 disabled:opacity-50"
          >
            {t('helmReleaseDetail.test.close')}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}
