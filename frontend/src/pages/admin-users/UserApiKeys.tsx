import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '@/services/api'
import { formatScope } from '@/pages/account/apiKeyFormat'
import { formatWhen } from '@/pages/admin/accessRequestFormat'

// Admin → Users → detail: the user's API keys. An admin revokes but never
// issues a key for someone else.

interface Props {
  userID: string
  canEdit: boolean
  tr: (key: string, fallback: string, opts?: any) => string
}

export default function UserApiKeys({ userID, canEdit, tr }: Props) {
  const queryClient = useQueryClient()
  const { data: keys = [] } = useQuery({ queryKey: ['api-keys', 'user', userID], queryFn: () => api.adminListUserAPIKeys(userID) })
  const [confirm, setConfirm] = useState<string | null>(null)
  const revoke = useMutation({
    mutationFn: (id: string) => api.adminDeleteUserAPIKey(userID, id),
    onSuccess: () => {
      setConfirm(null)
      queryClient.invalidateQueries({ queryKey: ['api-keys', 'user', userID] })
    },
  })

  return (
    <div data-testid="admin-user-api-keys">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">{tr('apiKeys.admin.title', 'API keys')}</h3>
      <div className="rounded-xl border border-slate-700/50 bg-slate-950/30 p-3 space-y-1.5">
        {keys.length === 0 ? (
          <p className="text-xs text-slate-500">{tr('apiKeys.admin.empty', 'No API keys')}</p>
        ) : (
          keys.map((k) => (
            <div key={k.id} className="flex items-center justify-between gap-3 text-sm" data-testid={`admin-api-key-${k.id}`}>
              <div className="min-w-0">
                <div className="text-slate-200 truncate">
                  <span className="font-medium">{k.name}</span>
                  <span className="ml-2 font-mono text-xs text-slate-400">{k.key_prefix}…</span>
                </div>
                <div className="text-xs text-slate-400 truncate">
                  {formatScope(k, tr('apiKeys.allClusters', 'All clusters you can reach'))} · {k.role_ceiling} ·{' '}
                  {tr('apiKeys.expiresAt', 'expires {{time}}', { time: formatWhen(k.expires_at) })}
                </div>
              </div>
              {canEdit &&
                (confirm === k.id ? (
                  <button
                    type="button"
                    data-testid={`admin-api-key-revoke-confirm-${k.id}`}
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(k.id)}
                    className="shrink-0 rounded-lg bg-red-600 px-2 py-1 text-xs text-white hover:bg-red-500 disabled:opacity-50"
                  >
                    {tr('apiKeys.confirmRevoke', 'Revoke now')}
                  </button>
                ) : (
                  <button
                    type="button"
                    data-testid={`admin-api-key-revoke-${k.id}`}
                    onClick={() => setConfirm(k.id)}
                    className="shrink-0 rounded-lg border border-slate-600 px-2 py-1 text-xs text-slate-300 hover:bg-slate-700"
                  >
                    {tr('apiKeys.revoke', 'Revoke')}
                  </button>
                ))}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
