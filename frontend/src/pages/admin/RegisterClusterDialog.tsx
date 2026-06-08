import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Upload, CheckCircle, XCircle, Loader2 } from 'lucide-react'

import { ModalOverlay } from '@/components/ModalOverlay'
import { clustersApi, type ConnectionResult } from '@/services/api/clusters'

interface Props {
  onClose: () => void
  onRegistered: () => void
}

type Tab = 'external' | 'self'

// Register a cluster (step 11). external = paste/upload a kubeconfig, test the
// connection, then register. self = register the in-cluster ServiceAccount
// (k8s deployment mode only). Registration is rollout-free — usable at once.
export default function RegisterClusterDialog({ onClose, onRegistered }: Props) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string) => t(key, { defaultValue: fallback })

  const [tab, setTab] = useState<Tab>('external')
  const [displayName, setDisplayName] = useState('')
  const [kubeconfig, setKubeconfig] = useState('')
  const [apiServerURL, setApiServerURL] = useState('')
  const [test, setTest] = useState<ConnectionResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const { data: deploymentMode } = useQuery({
    queryKey: ['deployment-mode'],
    queryFn: () => clustersApi.getDeploymentMode(),
    staleTime: 5 * 60_000,
  })
  const selfDisabled = deploymentMode === 'docker'

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    file.text().then((txt) => {
      setKubeconfig(txt)
      setTest(null)
    })
  }

  const runTest = async () => {
    setTesting(true)
    setError(null)
    try {
      setTest(await clustersApi.validateCluster(kubeconfig))
    } catch (e) {
      setTest({ healthy: false, error: (e as Error).message })
    } finally {
      setTesting(false)
    }
  }

  const canRegister =
    displayName.trim() !== '' &&
    (tab === 'self' ? !selfDisabled : kubeconfig.trim() !== '' && test?.healthy === true)

  const register = async () => {
    setSubmitting(true)
    setError(null)
    try {
      await clustersApi.registerCluster(
        tab === 'self'
          ? { mode: 'self', display_name: displayName.trim() }
          : {
              mode: 'external',
              display_name: displayName.trim(),
              kubeconfig,
              api_server_url: apiServerURL.trim() || undefined,
            },
      )
      onRegistered()
    } catch (e) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setError(detail || (e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  const tabClass = (active: boolean) =>
    `px-4 py-2 text-sm font-medium border-b-2 ${
      active ? 'border-primary-500 text-white' : 'border-transparent text-slate-400 hover:text-slate-200'
    }`

  return (
    <ModalOverlay onClose={onClose}>
      <div className="w-full max-w-lg rounded-xl border border-slate-700 bg-slate-800 shadow-2xl">
        <div className="px-6 pt-5 pb-3 border-b border-slate-700">
          <h2 className="text-lg font-bold text-white">
            {tr('cluster.register.title', 'Register cluster')}
          </h2>
        </div>

        <div className="flex gap-2 px-6 border-b border-slate-700">
          <button type="button" className={tabClass(tab === 'external')} onClick={() => setTab('external')}>
            {tr('cluster.register.external', 'External')}
          </button>
          <button
            type="button"
            data-testid="register-tab-self"
            className={tabClass(tab === 'self')}
            onClick={() => !selfDisabled && setTab('self')}
            disabled={selfDisabled}
            title={selfDisabled ? tr('cluster.register.selfDockerDisabled', 'Not available in docker mode') : ''}
          >
            {tr('cluster.register.self', 'This cluster (self)')}
          </button>
        </div>

        <div className="px-6 py-4 space-y-4 max-h-[60vh] overflow-auto">
          <div>
            <label className="block text-xs text-slate-400 mb-1">
              {tr('cluster.register.displayName', 'Display name')}
            </label>
            <input
              data-testid="register-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="prod-seoul"
              className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white"
            />
          </div>

          {tab === 'external' ? (
            <>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs text-slate-400">kubeconfig</label>
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    className="flex items-center gap-1 text-xs text-primary-400 hover:text-primary-300"
                  >
                    <Upload className="w-3 h-3" />
                    {tr('cluster.register.upload', 'Upload')}
                  </button>
                  <input ref={fileRef} type="file" accept=".yaml,.yml,.conf" className="hidden" onChange={onPickFile} />
                </div>
                <textarea
                  value={kubeconfig}
                  onChange={(e) => {
                    setKubeconfig(e.target.value)
                    setTest(null)
                  }}
                  rows={8}
                  placeholder="apiVersion: v1&#10;kind: Config&#10;..."
                  className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-xs font-mono text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">
                  {tr('cluster.register.apiServerOptional', 'API server URL (optional)')}
                </label>
                <input
                  value={apiServerURL}
                  onChange={(e) => setApiServerURL(e.target.value)}
                  placeholder="https://10.0.0.1:6443"
                  className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white"
                />
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={runTest}
                  disabled={kubeconfig.trim() === '' || testing}
                  className="flex items-center gap-2 rounded-lg border border-slate-600 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-700/40 disabled:opacity-50"
                >
                  {testing && <Loader2 className="w-4 h-4 animate-spin" />}
                  {tr('cluster.register.test', 'Test connection')}
                </button>
                {test && (
                  <span className={`flex items-center gap-1 text-sm ${test.healthy ? 'text-green-400' : 'text-red-400'}`}>
                    {test.healthy ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                    {test.healthy ? test.server_version || 'OK' : test.error || tr('cluster.register.testFailed', 'Failed')}
                  </span>
                )}
              </div>
            </>
          ) : (
            <p className="text-sm text-yellow-300/90 bg-yellow-900/20 border border-yellow-800/40 rounded-lg px-3 py-2">
              {tr(
                'cluster.register.selfWarning',
                'Registers the in-cluster ServiceAccount as a managed cluster — this may be a production cluster. Confirm the ServiceAccount permissions.',
              )}
            </p>
          )}

          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-slate-700">
          <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-slate-300 hover:bg-slate-700/40">
            {tr('common.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            data-testid="register-submit"
            onClick={register}
            disabled={!canRegister || submitting}
            className="flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm text-white hover:bg-primary-500 disabled:opacity-50"
          >
            {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
            {tr('cluster.register.submit', 'Register')}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}
