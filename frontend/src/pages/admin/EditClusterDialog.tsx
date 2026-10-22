import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Upload, Loader2, Activity } from 'lucide-react'

import { ModalFrame } from '@/components/ModalFrame'
import { modalButton } from '@/components/modalStyles'
import { clustersApi, type ClusterMeta, type ClusterPatch } from '@/services/api/clusters'
import { api } from '@/services/api'
import type { LogSearchStatus, PrometheusStatus } from '@/services/api/types'

// Edit a registered cluster: rename, (external only) rotate its kubeconfig
// when credentials change, and name an external Prometheus source and the
// cluster's own log store. The
// cluster id and all per-cluster RBAC grants are kept — the backend rejects a
// kubeconfig that points at a different physical cluster (kube-system UID
// mismatch). The Prometheus auth value is write-only: the dialog only knows
// whether one is stored.
interface Props {
  cluster: ClusterMeta
  onClose: () => void
  onSaved: () => void
}

type AuthType = 'keep' | 'none' | 'bearer' | 'basic'

const inputClass = 'mt-1 w-full rounded-lg border border-slate-600 bg-slate-900/60 px-3 py-2 text-sm text-white focus:border-primary-500 focus:outline-hidden'
const labelClass = 'block text-xs font-semibold text-slate-400'

// namespace/service:port[/path] — the server checks the same (services/pkg/cluster ParsePrometheusService).
const PROM_SERVICE_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?\/[a-z0-9]([-a-z0-9]*[a-z0-9])?:[0-9]{1,5}(\/[A-Za-z0-9._~-]+)*$/

export default function EditClusterDialog({ cluster, onClose, onSaved }: Props) {
  const { t } = useTranslation()
  const tr = (k: string, d: string, opts?: Record<string, unknown>) => t(k, { defaultValue: d, ...opts })
  const isSelf = cluster.is_self_cluster || cluster.mode === 'in_cluster'

  const [displayName, setDisplayName] = useState(cluster.display_name)
  const [kubeconfig, setKubeconfig] = useState('')
  const [promService, setPromService] = useState(cluster.prometheus_service ?? '')
  const [promUrl, setPromUrl] = useState(cluster.prometheus_url ?? '')
  const [promLabel, setPromLabel] = useState(cluster.prometheus_cluster_label ?? '')
  const [authType, setAuthType] = useState<AuthType>(cluster.prometheus_auth ? 'keep' : 'none')
  const [token, setToken] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [checking, setChecking] = useState(false)
  const [status, setStatus] = useState<PrometheusStatus | null>(null)
  const [lsUrl, setLsUrl] = useState(cluster.log_search_url ?? '')
  const [lsTenant, setLsTenant] = useState(cluster.log_search_tenant ?? '')
  const [lsLabel, setLsLabel] = useState(cluster.log_search_cluster_label ?? '')
  const [lsAuthType, setLsAuthType] = useState<AuthType>(cluster.log_search_auth ? 'keep' : 'none')
  const [lsToken, setLsToken] = useState('')
  const [lsUsername, setLsUsername] = useState('')
  const [lsPassword, setLsPassword] = useState('')
  const [lsChecking, setLsChecking] = useState(false)
  const [lsStatus, setLsStatus] = useState<LogSearchStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f) setKubeconfig(await f.text())
  }

  const authChanged = authType !== (cluster.prometheus_auth ? 'keep' : 'none')
  const authComplete = authType === 'bearer' ? token.trim() !== '' : authType === 'basic' ? username !== '' && password !== '' : true
  const serviceValid = promService.trim() === '' || PROM_SERVICE_RE.test(promService.trim())
  const lsAuthChanged = lsAuthType !== (cluster.log_search_auth ? 'keep' : 'none')
  const lsAuthComplete = lsAuthType === 'bearer' ? lsToken.trim() !== '' : lsAuthType === 'basic' ? lsUsername !== '' && lsPassword !== '' : true
  const dirty =
    displayName.trim() !== cluster.display_name ||
    kubeconfig.trim() !== '' ||
    promService.trim() !== (cluster.prometheus_service ?? '') ||
    promUrl.trim() !== (cluster.prometheus_url ?? '') ||
    promLabel.trim() !== (cluster.prometheus_cluster_label ?? '') ||
    authChanged ||
    lsUrl.trim() !== (cluster.log_search_url ?? '') ||
    lsTenant.trim() !== (cluster.log_search_tenant ?? '') ||
    lsLabel.trim() !== (cluster.log_search_cluster_label ?? '') ||
    lsAuthChanged
  const canSave = displayName.trim() !== '' && dirty && authComplete && lsAuthComplete && serviceValid && !saving

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const patch: ClusterPatch = {}
      if (displayName.trim() !== cluster.display_name) patch.display_name = displayName.trim()
      if (kubeconfig.trim() !== '') patch.kubeconfig = kubeconfig
      if (promService.trim() !== (cluster.prometheus_service ?? '')) patch.prometheus_service = promService.trim()
      if (promUrl.trim() !== (cluster.prometheus_url ?? '')) patch.prometheus_url = promUrl.trim()
      if (promLabel.trim() !== (cluster.prometheus_cluster_label ?? '')) patch.prometheus_cluster_label = promLabel.trim()
      if (authType === 'none' && cluster.prometheus_auth) patch.prometheus_auth = { type: 'none' }
      if (authType === 'bearer') patch.prometheus_auth = { type: 'bearer', token: token.trim() }
      if (authType === 'basic') patch.prometheus_auth = { type: 'basic', username, password }
      if (lsUrl.trim() !== (cluster.log_search_url ?? '')) patch.log_search_url = lsUrl.trim()
      if (lsTenant.trim() !== (cluster.log_search_tenant ?? '')) patch.log_search_tenant = lsTenant.trim()
      if (lsLabel.trim() !== (cluster.log_search_cluster_label ?? '')) patch.log_search_cluster_label = lsLabel.trim()
      if (lsAuthType === 'none' && cluster.log_search_auth) patch.log_search_auth = { type: 'none' }
      if (lsAuthType === 'bearer') patch.log_search_auth = { type: 'bearer', token: lsToken.trim() }
      if (lsAuthType === 'basic') patch.log_search_auth = { type: 'basic', username: lsUsername, password: lsPassword }
      await clustersApi.updateCluster(cluster.id, patch)
      onSaved()
    } catch (e: unknown) {
      const resp = (e as { response?: { data?: { detail?: string } } }).response
      setError(resp?.data?.detail ?? (e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const check = async () => {
    setChecking(true)
    setStatus(null)
    try {
      setStatus(await api.getPrometheusStatus(cluster.id))
    } catch (e: unknown) {
      setStatus({ available: false, source: 'none', message: (e as Error).message })
    } finally {
      setChecking(false)
    }
  }

  const checkLogSearch = async () => {
    setLsChecking(true)
    setLsStatus(null)
    try {
      setLsStatus(await api.getLogSearchStatus(cluster.id))
    } catch (e: unknown) {
      setLsStatus({ available: false, source: 'none', message: (e as Error).message })
    } finally {
      setLsChecking(false)
    }
  }

  const lsStatusText = (s: LogSearchStatus) => {
    const state = s.available ? tr('cluster.edit.prometheus.ok', 'OK') : tr('cluster.edit.prometheus.fail', 'failed: {{message}}', { message: s.message ?? '' })
    if (s.source === 'cluster') return tr('cluster.edit.logSearch.resultCluster', "This cluster's store {{endpoint}} — {{state}}", { endpoint: s.endpoint, state })
    if (s.source === 'global') return tr('cluster.edit.logSearch.resultGlobal', 'Deployment store {{endpoint}} — {{state}}', { endpoint: s.endpoint, state })
    return tr('cluster.edit.logSearch.resultNone', 'No log store: {{message}}', { message: s.message ?? '' })
  }

  const statusText = (s: PrometheusStatus) => {
    const text = statusBody(s)
    return s.flavor === 'victoriametrics' ? `${text} · VictoriaMetrics` : text
  }
  const statusBody = (s: PrometheusStatus) => {
    if (s.source === 'external') {
      return tr('cluster.edit.prometheus.resultExternal', 'External store {{endpoint}} — {{state}}', {
        endpoint: s.endpoint,
        state: s.available ? tr('cluster.edit.prometheus.ok', 'OK') : tr('cluster.edit.prometheus.fail', 'failed: {{message}}', { message: s.message ?? '' }),
      })
    }
    if (s.source === 'proxy' && s.configured) {
      return tr('cluster.edit.prometheus.resultConfigured', 'Service {{endpoint}} — {{state}}', {
        endpoint: s.endpoint,
        state: s.available ? tr('cluster.edit.prometheus.ok', 'OK') : tr('cluster.edit.prometheus.fail', 'failed: {{message}}', { message: s.message ?? '' }),
      })
    }
    if (s.source === 'proxy') return tr('cluster.edit.prometheus.resultProxy', 'Found inside the cluster: {{endpoint}}', { endpoint: s.endpoint })
    const message = s.reason ? tr(`cluster.edit.prometheus.reason.${s.reason}`, s.message ?? '') : (s.message ?? '')
    return tr('cluster.edit.prometheus.resultNone', 'No Prometheus: {{message}}', { message })
  }

  return (
    <ModalFrame
      size="md"
      body="scroll"
      title={`${tr('cluster.edit.title', 'Edit cluster')} — ${cluster.id}`}
      onClose={onClose}
      busy={saving}
      testId="edit-cluster-dialog"
      footer={
        <>
          <button type="button" onClick={onClose} disabled={saving} className={modalButton.cancel}>
            {tr('common.cancel', 'Cancel')}
          </button>
          <button type="button" data-testid="edit-submit" onClick={save} disabled={!canSave} className={modalButton.primary}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {tr('common.save', 'Save')}
          </button>
        </>
      }
    >
        <label className={labelClass}>
          {tr('cluster.register.displayName', 'Display name')}
        </label>
        <input
          data-testid="edit-name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className={inputClass}
        />

        {!isSelf && (
          <>
            <div className="mt-4 flex items-center justify-between">
              <label className={labelClass}>
                {tr('cluster.edit.kubeconfig', 'Replace kubeconfig (optional)')}
              </label>
              <button
                onClick={() => fileRef.current?.click()}
                className="inline-flex items-center gap-1 text-xs text-slate-300 hover:text-white"
              >
                <Upload className="h-3.5 w-3.5" />
                {tr('cluster.register.upload', 'Upload')}
              </button>
              <input ref={fileRef} type="file" className="hidden" onChange={onFile} />
            </div>
            <textarea
              data-testid="edit-kubeconfig"
              value={kubeconfig}
              onChange={(e) => setKubeconfig(e.target.value)}
              placeholder={tr('cluster.edit.kubeconfigHint', 'Leave blank to keep the current kubeconfig. Paste a new one to rotate credentials.')}
              rows={7}
              className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-900/60 px-3 py-2 font-mono text-xs text-white focus:border-primary-500 focus:outline-hidden"
            />
            <p className="mt-1 text-[11px] text-slate-500">
              {tr('cluster.edit.sameClusterNote', 'A new kubeconfig must point to the same cluster — RBAC grants and chat history are preserved.')}
            </p>
          </>
        )}

        <div className="mt-5 border-t border-slate-700 pt-4" data-testid="edit-prometheus">
          <p className="text-sm font-semibold text-white">{tr('cluster.edit.prometheus.title', 'Prometheus')}</p>
          <p className="mt-1 text-[11px] text-slate-500">
            {tr('cluster.edit.prometheus.hint', 'Leave everything empty to find Prometheus inside the cluster. Name its Service if discovery cannot; for a central store (Thanos, Mimir, VictoriaMetrics, …) enter its URL and the value of this cluster\'s label.')}
          </p>
          <label className={`${labelClass} mt-3`}>{tr('cluster.edit.prometheus.service', 'Service in the cluster')}</label>
          <input
            data-testid="edit-prometheus-service"
            value={promService}
            onChange={(e) => setPromService(e.target.value)}
            placeholder="monitoring/prometheus:9090"
            className={inputClass}
          />
          <p className={`mt-1 text-[11px] ${serviceValid ? 'text-slate-500' : 'text-red-400'}`} data-testid="edit-prometheus-service-hint">
            {serviceValid
              ? tr('cluster.edit.prometheus.serviceHint', 'namespace/service:port, with the path the API sits under if it has one (a VictoriaMetrics cluster: monitoring/vmselect-main:8481/select/0/prometheus), read through the API server. Leave empty to find Prometheus (or a single-node VictoriaMetrics) by label, then by name. A URL below takes precedence.')
              : tr('cluster.edit.prometheus.serviceInvalid', 'Use namespace/service:port[/path], for example monitoring/prometheus:9090.')}
          </p>
          <label className={`${labelClass} mt-3`}>{tr('cluster.edit.prometheus.url', 'URL')}</label>
          <input
            data-testid="edit-prometheus-url"
            value={promUrl}
            onChange={(e) => setPromUrl(e.target.value)}
            placeholder={tr('cluster.edit.prometheus.urlPlaceholder', 'https://metrics.example.com/prometheus')}
            className={inputClass}
          />
          <label className={`${labelClass} mt-3`}>{tr('cluster.edit.prometheus.label', 'Cluster label value')}</label>
          <input
            data-testid="edit-prometheus-label"
            value={promLabel}
            onChange={(e) => setPromLabel(e.target.value)}
            className={inputClass}
          />
          <p className="mt-1 text-[11px] text-slate-500">
            {tr('cluster.edit.prometheus.labelHint', 'The {{name}} label the store puts on this cluster\'s series — every query gets {{name}}="value". Leave empty when the store holds only this cluster.', { name: status?.label_name ?? 'cluster' })}
          </p>
          <label className={`${labelClass} mt-3`}>{tr('cluster.edit.prometheus.auth', 'Authentication')}</label>
          <select
            data-testid="edit-prometheus-auth"
            value={authType}
            onChange={(e) => setAuthType(e.target.value as AuthType)}
            className={inputClass}
          >
            {cluster.prometheus_auth && <option value="keep">{tr('cluster.edit.prometheus.authKeep', 'Set — kept unless changed')}</option>}
            <option value="none">{cluster.prometheus_auth ? tr('cluster.edit.prometheus.authClear', 'Remove the stored credentials') : tr('cluster.edit.prometheus.authNone', 'None')}</option>
            <option value="bearer">{tr('cluster.edit.prometheus.authBearer', 'Bearer token')}</option>
            <option value="basic">{tr('cluster.edit.prometheus.authBasic', 'Basic (username / password)')}</option>
          </select>
          {authType === 'bearer' && (
            <>
              <label className={`${labelClass} mt-3`}>{tr('cluster.edit.prometheus.token', 'Token')}</label>
              <input data-testid="edit-prometheus-token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} className={inputClass} />
            </>
          )}
          {authType === 'basic' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={`${labelClass} mt-3`}>{tr('cluster.edit.prometheus.username', 'Username')}</label>
                <input data-testid="edit-prometheus-username" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className={`${labelClass} mt-3`}>{tr('cluster.edit.prometheus.password', 'Password')}</label>
                <input data-testid="edit-prometheus-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} />
              </div>
            </div>
          )}
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              data-testid="edit-prometheus-check"
              onClick={check}
              disabled={checking}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm bg-slate-700 px-3 text-xs text-white hover:bg-slate-600 disabled:opacity-50"
            >
              {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Activity className="h-3.5 w-3.5" />}
              {checking ? tr('cluster.edit.prometheus.checking', 'Checking...') : tr('cluster.edit.prometheus.check', 'Check connection')}
            </button>
            <span className="text-[11px] text-slate-500">{tr('cluster.edit.prometheus.checkNote', 'The check uses the saved settings. Save first, then check changed values.')}</span>
          </div>
          {status && (
            <p data-testid="edit-prometheus-status" className={`mt-2 text-xs break-all ${status.available ? 'text-emerald-300' : 'text-amber-300'}`}>
              {statusText(status)}
            </p>
          )}
        </div>

        {/* The cluster's own log store, before the deployment-wide features.logSearch. */}
        <div className="mt-5 border-t border-slate-700 pt-4" data-testid="edit-logsearch">
          <p className="text-sm font-semibold text-white">{tr('cluster.edit.logSearch.title', 'Log search')}</p>
          <p className="mt-1 text-[11px] text-slate-500">
            {tr('cluster.edit.logSearch.hint', "Leave everything empty to search the deployment's log store (features.logSearch). Enter a URL when this cluster's logs live in another Loki — it is used for this cluster only.")}
          </p>
          <label className={`${labelClass} mt-3`}>{tr('cluster.edit.logSearch.url', 'URL')}</label>
          <input
            data-testid="edit-logsearch-url"
            value={lsUrl}
            onChange={(e) => setLsUrl(e.target.value)}
            placeholder={tr('cluster.edit.logSearch.urlPlaceholder', 'https://loki.example.com')}
            className={inputClass}
          />
          <label className={`${labelClass} mt-3`}>{tr('cluster.edit.logSearch.tenant', 'Tenant (X-Scope-OrgID)')}</label>
          <input data-testid="edit-logsearch-tenant" value={lsTenant} onChange={(e) => setLsTenant(e.target.value)} className={inputClass} />
          <p className="mt-1 text-[11px] text-slate-500">{tr('cluster.edit.logSearch.tenantHint', 'For a multi-tenant Loki. Leave empty otherwise.')}</p>
          <label className={`${labelClass} mt-3`}>{tr('cluster.edit.logSearch.label', 'Cluster label value')}</label>
          <input data-testid="edit-logsearch-label" value={lsLabel} onChange={(e) => setLsLabel(e.target.value)} className={inputClass} />
          <p className="mt-1 text-[11px] text-slate-500">
            {tr('cluster.edit.logSearch.labelHint', 'The {{name}} label this cluster\'s streams carry in that store — every query gets {{name}}="value". Leave empty when the store holds only this cluster.', { name: lsStatus?.label_name || 'k8s_cluster_name' })}
          </p>
          <label className={`${labelClass} mt-3`}>{tr('cluster.edit.logSearch.auth', 'Authentication')}</label>
          <select data-testid="edit-logsearch-auth" value={lsAuthType} onChange={(e) => setLsAuthType(e.target.value as AuthType)} className={inputClass}>
            {cluster.log_search_auth && <option value="keep">{tr('cluster.edit.prometheus.authKeep', 'Set — kept unless changed')}</option>}
            <option value="none">{cluster.log_search_auth ? tr('cluster.edit.prometheus.authClear', 'Remove the stored credentials') : tr('cluster.edit.prometheus.authNone', 'None')}</option>
            <option value="bearer">{tr('cluster.edit.prometheus.authBearer', 'Bearer token')}</option>
            <option value="basic">{tr('cluster.edit.prometheus.authBasic', 'Basic (username / password)')}</option>
          </select>
          {lsAuthType === 'bearer' && (
            <>
              <label className={`${labelClass} mt-3`}>{tr('cluster.edit.prometheus.token', 'Token')}</label>
              <input data-testid="edit-logsearch-token" type="password" autoComplete="off" value={lsToken} onChange={(e) => setLsToken(e.target.value)} className={inputClass} />
            </>
          )}
          {lsAuthType === 'basic' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={`${labelClass} mt-3`}>{tr('cluster.edit.prometheus.username', 'Username')}</label>
                <input data-testid="edit-logsearch-username" autoComplete="off" value={lsUsername} onChange={(e) => setLsUsername(e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className={`${labelClass} mt-3`}>{tr('cluster.edit.prometheus.password', 'Password')}</label>
                <input data-testid="edit-logsearch-password" type="password" autoComplete="new-password" value={lsPassword} onChange={(e) => setLsPassword(e.target.value)} className={inputClass} />
              </div>
            </div>
          )}
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              data-testid="edit-logsearch-check"
              onClick={checkLogSearch}
              disabled={lsChecking}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm bg-slate-700 px-3 text-xs text-white hover:bg-slate-600 disabled:opacity-50"
            >
              {lsChecking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Activity className="h-3.5 w-3.5" />}
              {lsChecking ? tr('cluster.edit.prometheus.checking', 'Checking...') : tr('cluster.edit.logSearch.check', 'Check connection')}
            </button>
            <span className="text-[11px] text-slate-500">{tr('cluster.edit.prometheus.checkNote', 'The check uses the saved settings. Save first, then check changed values.')}</span>
          </div>
          {lsStatus && (
            <p data-testid="edit-logsearch-status" className={`mt-2 text-xs break-all ${lsStatus.available ? 'text-emerald-300' : 'text-amber-300'}`}>
              {lsStatusText(lsStatus)}
            </p>
          )}
        </div>

        {error && (
          <div className="mt-3 rounded-lg border border-red-700/60 bg-red-900/30 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}
    </ModalFrame>
  )
}
