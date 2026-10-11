import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Check, Copy, KeySquare, Loader2 } from 'lucide-react'

import { api } from '@/services/api'
import { clustersApi } from '@/services/api/clusters'
import type { CreatedAPIKey } from '@/services/api/api_keys'
import CustomDropdown from '@/components/CustomDropdown'
import { ModalFrame } from '@/components/ModalFrame'
import { modalButton } from '@/components/modalStyles'
import { formatWhen } from '@/pages/admin/accessRequestFormat'
import { formatScope } from './apiKeyFormat'

// Settings → API keys: the signed-in user's keys for automation. A key is
// issued once (name, expiry, clusters, role ceiling), shown a single time,
// and revoked from the list. Shown only while the installation allows keys.

const CEILINGS = ['Read', 'Write', 'Admin']

export default function ApiKeysSection() {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, opts?: Record<string, unknown>) => t(key, { defaultValue: fallback, ...opts })
  const queryClient = useQueryClient()

  const { data: config } = useQuery({ queryKey: ['api-keys', 'config'], queryFn: api.getAPIKeysConfig, staleTime: 60_000 })
  const enabled = !!config?.enabled
  const maxDays = config?.max_days ?? 90
  const { data: keys = [] } = useQuery({ queryKey: ['api-keys', 'mine'], queryFn: api.listMyAPIKeys, enabled })
  const { data: clusters = [] } = useQuery({
    queryKey: ['clusters-accessible'],
    queryFn: () => clustersApi.listClusters(true),
    staleTime: 30_000,
    enabled,
  })

  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [days, setDays] = useState(30)
  const [selected, setSelected] = useState<string[]>([])
  const [ceiling, setCeiling] = useState('Read')
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<CreatedAPIKey | null>(null)
  const [copied, setCopied] = useState(false)
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null)

  const openModal = () => {
    setName('')
    setDays(Math.min(30, maxDays))
    setSelected([])
    setCeiling('Read')
    setError(null)
    setOpen(true)
  }

  const create = useMutation({
    mutationFn: () =>
      api.createAPIKey({
        name: name.trim(),
        expires_in_days: days,
        cluster_ids: selected.length > 0 ? selected : undefined,
        role_ceiling: ceiling,
      }),
    onSuccess: (key) => {
      setOpen(false)
      setCreated(key)
      setCopied(false)
      queryClient.invalidateQueries({ queryKey: ['api-keys', 'mine'] })
    },
    onError: (err: any) => setError(err?.response?.data?.detail || tr('apiKeys.failed', 'The key was not created.')),
  })
  const revoke = useMutation({
    mutationFn: (id: string) => api.deleteAPIKey(id),
    onSuccess: () => {
      setConfirmRevoke(null)
      queryClient.invalidateQueries({ queryKey: ['api-keys', 'mine'] })
    },
  })

  if (!enabled) return null

  const copy = async () => {
    if (!created) return
    try {
      await navigator.clipboard.writeText(created.key)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
  const allLabel = tr('apiKeys.allClusters', 'All clusters you can reach')

  return (
    <div className="card" data-testid="account-api-keys">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary-600/20 rounded-lg">
            <KeySquare className="w-5 h-5 text-primary-400" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-white">{tr('apiKeys.title', 'API keys')}</h2>
            <p className="text-slate-400 text-sm">
              {tr('apiKeys.subtitle', 'For scripts and CI. A key is exchanged for a short access token and never grants more than you hold.')}
            </p>
          </div>
        </div>
        <button
          type="button"
          data-testid="api-key-create-open"
          onClick={openModal}
          className="btn btn-primary shrink-0"
        >
          {tr('apiKeys.create', 'Create key')}
        </button>
      </div>

      {created && (
        <div className="mb-4 rounded-lg border border-emerald-800/60 bg-emerald-900/20 p-3" data-testid="api-key-created">
          <div className="text-sm text-emerald-200 mb-2">
            {tr('apiKeys.onceWarning', 'Copy the key now — it is shown only this once.')}
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded-sm bg-slate-950/60 px-2 py-1.5 font-mono text-xs text-white" data-testid="api-key-value">
              {created.key}
            </code>
            <button
              type="button"
              data-testid="api-key-copy"
              onClick={copy}
              className="rounded-lg border border-slate-600 px-2 py-1.5 text-xs text-slate-200 hover:bg-slate-700"
            >
              {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
            </button>
            <button
              type="button"
              data-testid="api-key-created-dismiss"
              onClick={() => setCreated(null)}
              className="rounded-lg border border-slate-600 px-2 py-1.5 text-xs text-slate-300 hover:bg-slate-700"
            >
              {tr('apiKeys.done', 'Done')}
            </button>
          </div>
        </div>
      )}

      {keys.length === 0 ? (
        <p className="text-sm text-slate-400">{tr('apiKeys.empty', 'No keys yet.')}</p>
      ) : (
        <div className="space-y-1.5" data-testid="api-key-list">
          {keys.map((k) => (
            <div key={k.id} className="flex items-center justify-between gap-3 rounded-lg bg-slate-900/40 px-3 py-2" data-testid={`api-key-row-${k.id}`}>
              <div className="min-w-0">
                <div className="text-sm text-white truncate">
                  <span className="font-medium">{k.name}</span>
                  <span className="ml-2 font-mono text-xs text-slate-400">{k.key_prefix}…</span>
                </div>
                <div className="text-xs text-slate-400 truncate">
                  {formatScope(k, allLabel)} · {k.role_ceiling} · {tr('apiKeys.expiresAt', 'expires {{time}}', { time: formatWhen(k.expires_at) })}
                  {' · '}
                  {k.last_used_at
                    ? tr('apiKeys.lastUsed', 'last used {{time}}', { time: formatWhen(k.last_used_at) })
                    : tr('apiKeys.never', 'never used')}
                </div>
              </div>
              {confirmRevoke === k.id ? (
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    data-testid={`api-key-revoke-confirm-${k.id}`}
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(k.id)}
                    className="rounded-lg bg-red-600 px-2 py-1 text-xs text-white hover:bg-red-500 disabled:opacity-50"
                  >
                    {tr('apiKeys.confirmRevoke', 'Revoke now')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmRevoke(null)}
                    className="rounded-lg border border-slate-600 px-2 py-1 text-xs text-slate-300 hover:bg-slate-700"
                  >
                    {tr('apiKeys.cancel', 'Cancel')}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  data-testid={`api-key-revoke-${k.id}`}
                  onClick={() => setConfirmRevoke(k.id)}
                  className="shrink-0 rounded-lg border border-slate-600 px-2 py-1 text-xs text-slate-300 hover:bg-slate-700"
                >
                  {tr('apiKeys.revoke', 'Revoke')}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {open && (
        <ModalFrame
          size="md"
          title={tr('apiKeys.create', 'Create key')}
          onClose={() => setOpen(false)}
          busy={create.isPending}
          testId="api-key-modal"
          footer={
            <>
              <button type="button" onClick={() => setOpen(false)} className={modalButton.cancel} disabled={create.isPending}>
                {tr('apiKeys.cancel', 'Cancel')}
              </button>
              <button
                type="button"
                data-testid="api-key-submit"
                disabled={create.isPending || name.trim() === '' || days < 1 || days > maxDays}
                onClick={() => create.mutate()}
                className={modalButton.primary}
              >
                {create.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                {tr('apiKeys.issue', 'Issue key')}
              </button>
            </>
          }
        >
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1">{tr('apiKeys.name', 'Name')}</label>
                <input
                  data-testid="api-key-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={64}
                  placeholder={tr('apiKeys.namePlaceholder', 'e.g. deploy pipeline')}
                  className="w-full h-10 rounded-lg border border-slate-700 bg-slate-950/60 px-3 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1">
                  {tr('apiKeys.expires', 'Expires in (days)')}
                  <span className="ml-1 text-slate-500">{tr('apiKeys.expiresHint', 'up to {{max}}', { max: maxDays })}</span>
                </label>
                <input
                  data-testid="api-key-days"
                  type="number"
                  min={1}
                  max={maxDays}
                  value={days}
                  onChange={(e) => setDays(Number(e.target.value))}
                  className="w-full h-10 rounded-lg border border-slate-700 bg-slate-950/60 px-3 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1">{tr('apiKeys.clusters', 'Clusters')}</label>
                {clusters.length === 0 ? (
                  <p className="text-xs text-slate-500">{allLabel}</p>
                ) : (
                  <div className="space-y-1 rounded-lg border border-slate-700/60 p-2" data-testid="api-key-clusters">
                    {clusters.map((c) => (
                      <label key={c.id} className="flex items-center gap-2 text-sm text-slate-200">
                        <input type="checkbox" checked={selected.includes(c.id)} onChange={() => toggle(c.id)} data-testid={`api-key-cluster-${c.id}`} />
                        <span>{c.display_name}</span>
                        <span className="font-mono text-xs text-slate-500">{c.id}</span>
                      </label>
                    ))}
                    <p className="text-xs text-slate-500">{tr('apiKeys.clustersHint', 'None selected = every cluster you can reach.')}</p>
                  </div>
                )}
              </div>
              <CustomDropdown
                label={tr('apiKeys.ceiling', 'Role ceiling')}
                options={CEILINGS.map((r) => ({ value: r, label: r }))}
                value={ceiling}
                onChange={setCeiling}
                testId="api-key-ceiling"
              />
              <p className="text-xs text-slate-500">{tr('apiKeys.ceilingHint', 'The key never exceeds your own role on a cluster.')}</p>
              {error && <p className="text-sm text-red-300" data-testid="api-key-error">{error}</p>}
            </div>
        </ModalFrame>
      )}
    </div>
  )
}
