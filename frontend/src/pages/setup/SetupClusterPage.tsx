import { CheckCircle2, Database, UploadCloud } from 'lucide-react'
import type { SetupMode } from './types'

interface SetupClusterPageProps {
  mode: SetupMode
  setMode: (mode: SetupMode) => void
  kubeconfigText: string
  setKubeconfigText: (text: string) => void
  error: string | null
  isApplying: boolean
  isBusy: boolean
  isLoadingStatus: boolean
  canSubmit: boolean
  onSubmit: () => void
  tr: (key: string, fallback: string) => string
}

export default function SetupClusterPage({
  mode,
  setMode,
  kubeconfigText,
  setKubeconfigText,
  error,
  isApplying,
  isBusy,
  isLoadingStatus,
  canSubmit,
  onSubmit,
  tr,
}: SetupClusterPageProps) {
  const handleFileUpload = (file?: File | null) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setKubeconfigText(String(reader.result || ''))
    reader.readAsText(file)
  }

  return (
    <div
      className={`mx-auto w-full max-w-3xl space-y-8 transition-opacity duration-300 ${
        isApplying ? 'pointer-events-none opacity-40' : ''
      }`}
    >
      {/* header */}
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

      {/* mode selector */}
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

      {/* kubeconfig input */}
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

      {/* error */}
      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      )}

      {/* submit */}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onSubmit}
          disabled={!canSubmit || isBusy || isLoadingStatus}
          className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isBusy
            ? tr('setup.submit.loading', 'Applying...')
            : tr('setup.submit', 'Continue')}
        </button>
      </div>
    </div>
  )
}
