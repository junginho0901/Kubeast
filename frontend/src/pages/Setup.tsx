import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { api } from '@/services/api'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, Database, UploadCloud } from 'lucide-react'

type SetupMode = 'in_cluster' | 'external'

export default function Setup() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })

  const [mode, setMode] = useState<SetupMode>('in_cluster')
  const [kubeconfigText, setKubeconfigText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isApplying, setIsApplying] = useState(false)

  const { data: status, isLoading: isLoadingStatus } = useQuery({
    queryKey: ['setup-status'],
    queryFn: api.getSetupStatus,
  })

  useEffect(() => {
    if (status?.configured && !isApplying) {
      navigate('/login', { replace: true })
    }
  }, [status, navigate, isApplying])

  const waitForHealth = async (timeoutMs: number = 60000, intervalMs: number = 2000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        await api.getHealth()
        return true
      } catch {
        await new Promise((resolve) => setTimeout(resolve, intervalMs))
      }
    }
    return false
  }

  const submitMutation = useMutation({
    mutationFn: () =>
      api.submitSetup({
        mode,
        kubeconfig: mode === 'external' ? kubeconfigText.trim() : undefined,
      }),
    onSuccess: async () => {
      setIsApplying(true)
      const ok = await waitForHealth()
      if (ok) {
        navigate('/login', { replace: true })
        return
      }
      setError(tr('setup.errors.timeout', 'Setup applied but cluster is still starting. Please try again.'))
      setIsApplying(false)
    },
    onError: (err: any) => {
      setError(err?.response?.data?.detail || tr('setup.errors.failed', 'Failed to apply setup.'))
      setIsApplying(false)
    },
  })

  const isBusy = submitMutation.isPending || isApplying

  const handleFileUpload = (file?: File | null) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      setKubeconfigText(String(reader.result || ''))
    }
    reader.readAsText(file)
  }

  const canSubmit = useMemo(() => {
    if (mode === 'external') {
      return Boolean(kubeconfigText.trim())
    }
    return true
  }, [mode, kubeconfigText])

  const handleSubmit = () => {
    if (!canSubmit || isBusy) return
    setError(null)
    submitMutation.mutate()
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(37,99,235,0.18),rgba(2,6,23,0))]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom,rgba(34,211,238,0.12),rgba(2,6,23,0))]" />
      </div>

      <div className="relative mx-auto flex min-h-screen w-[min(92vw,1200px)] items-center px-6 py-12">
        {isApplying && (
          <div className="absolute inset-0 z-20 flex items-center justify-center">
            <div className="rounded-2xl border border-slate-800 bg-slate-900/80 px-8 py-6 text-center shadow-xl backdrop-blur">
              <div className="mx-auto mb-4 h-10 w-10 rounded-full border-2 border-primary-500 border-t-transparent animate-spin" />
              <h2 className="text-lg font-semibold">{tr('setup.applying.title', 'Applying cluster configuration')}</h2>
              <p className="mt-2 text-sm text-slate-400">
                {tr('setup.applying.subtitle', 'Waiting for the cluster to become available...')}
              </p>
            </div>
          </div>
        )}
        <div className={`mx-auto w-full max-w-3xl space-y-8 ${isApplying ? 'pointer-events-none opacity-60' : ''}`}>
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900/40 px-3 py-1 text-xs text-slate-300">
              <div className="h-2 w-2 rounded-full bg-primary-500" />
              {tr('setup.badge', 'Initial cluster setup')}
            </div>
            <h1 className="text-3xl font-semibold">
              {tr('setup.title', 'Connect a Kubernetes cluster')}
            </h1>
            <p className="text-sm text-slate-400">
              {tr('setup.subtitle', 'Choose the cluster to manage before signing in.')}
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <button
              type="button"
              onClick={() => setMode('in_cluster')}
              className={`rounded-2xl border px-4 py-5 text-left transition ${
                mode === 'in_cluster'
                  ? 'border-primary-500/60 bg-primary-500/10'
                  : 'border-slate-800 bg-slate-900/40 hover:border-slate-700'
              }`}
            >
              <div className="flex items-center gap-2 text-sm font-semibold">
                <CheckCircle2 className="h-4 w-4 text-primary-400" />
                {tr('setup.option.incluster.title', 'Use this cluster')}
              </div>
              <p className="mt-2 text-xs text-slate-400">
                {tr('setup.option.incluster.desc', 'Manage the cluster where this solution is installed.')}
              </p>
            </button>

            <button
              type="button"
              onClick={() => setMode('external')}
              className={`rounded-2xl border px-4 py-5 text-left transition ${
                mode === 'external'
                  ? 'border-primary-500/60 bg-primary-500/10'
                  : 'border-slate-800 bg-slate-900/40 hover:border-slate-700'
              }`}
            >
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Database className="h-4 w-4 text-cyan-400" />
                {tr('setup.option.external.title', 'Connect external cluster')}
              </div>
              <p className="mt-2 text-xs text-slate-400">
                {tr('setup.option.external.desc', 'Provide a kubeconfig to connect another cluster.')}
              </p>
            </button>
          </div>

          {mode === 'external' && (
            <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm font-semibold">
                  {tr('setup.external.title', 'Kubeconfig')}
                </div>
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-1 text-xs text-slate-200">
                  <UploadCloud className="h-4 w-4 text-slate-300" />
                  {tr('setup.external.upload', 'Upload file')}
                  <input
                    type="file"
                    accept=".yaml,.yml,.conf,.txt"
                    className="hidden"
                    onChange={(e) => handleFileUpload(e.target.files?.[0])}
                  />
                </label>
              </div>
              <textarea
                className="mt-3 h-48 w-full rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-600"
                placeholder={tr('setup.external.placeholder', 'Paste kubeconfig content here...')}
                value={kubeconfigText}
                onChange={(e) => setKubeconfigText(e.target.value)}
              />
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              {error}
            </div>
          )}

          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit || isBusy || isLoadingStatus}
              className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isBusy ? tr('setup.submit.loading', 'Applying...') : tr('setup.submit', 'Continue')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
