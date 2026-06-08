import { useState } from 'react'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, Activity, Loader2, Server } from 'lucide-react'

import { ModalOverlay } from '@/components/ModalOverlay'
import { clustersApi, type ClusterMeta, type ConnectionResult } from '@/services/api/clusters'
import RegisterClusterDialog from './RegisterClusterDialog'

function healthDotClass(status: string | undefined): string {
  if (status === 'healthy') return 'bg-green-500'
  if (status === 'unhealthy' || status === 'disconnected') return 'bg-red-500'
  return 'bg-slate-500'
}

// Admin > Clusters (step 11): list every registered cluster with register /
// connection-test / delete. Registration & deletion are rollout-free, so the
// picker (clusters-accessible) is invalidated right after to reflect changes.
export default function AdminClusters() {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string) => t(key, { defaultValue: fallback })
  const queryClient = useQueryClient()

  const [registerOpen, setRegisterOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ClusterMeta | null>(null)
  const [testResults, setTestResults] = useState<Record<string, ConnectionResult>>({})
  const [testingId, setTestingId] = useState<string | null>(null)

  const { data: clusters = [], isLoading } = useQuery({
    queryKey: ['clusters-all'],
    queryFn: () => clustersApi.listClusters(false),
    staleTime: 30_000,
  })

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['clusters-all'] })
    queryClient.invalidateQueries({ queryKey: ['clusters-accessible'] })
  }

  const deleteMutation = useMutation({
    mutationFn: (id: string) => clustersApi.deleteCluster(id),
    onSuccess: () => {
      setDeleteTarget(null)
      refresh()
    },
  })

  const runTest = async (id: string) => {
    setTestingId(id)
    try {
      const res = await clustersApi.testCluster(id)
      setTestResults((p) => ({ ...p, [id]: res }))
      refresh()
    } catch (e) {
      setTestResults((p) => ({ ...p, [id]: { healthy: false, error: (e as Error).message } }))
    } finally {
      setTestingId(null)
    }
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Server className="w-6 h-6 text-primary-500" />
            {tr('cluster.admin.title', 'Clusters')}
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            {tr('cluster.admin.subtitle', 'Register and manage the clusters this platform connects to.')}
          </p>
        </div>
        <button
          type="button"
          data-testid="register-cluster-btn"
          onClick={() => setRegisterOpen(true)}
          className="flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm text-white hover:bg-primary-500"
        >
          <Plus className="w-4 h-4" />
          {tr('cluster.admin.register', 'Register cluster')}
        </button>
      </div>

      <div className="card overflow-hidden p-0">
        <table data-testid="clusters-table" className="w-full text-sm">
          <thead className="bg-slate-900/40 text-slate-400">
            <tr>
              <th className="text-left px-4 py-3">{tr('cluster.admin.name', 'Name')}</th>
              <th className="text-left px-4 py-3">{tr('cluster.admin.mode', 'Mode')}</th>
              <th className="text-left px-4 py-3">{tr('cluster.admin.apiServer', 'API server')}</th>
              <th className="text-left px-4 py-3">{tr('cluster.admin.health', 'Health')}</th>
              <th className="text-left px-4 py-3">{tr('cluster.admin.createdBy', 'Created by')}</th>
              <th className="text-right px-4 py-3">{tr('cluster.admin.actions', 'Actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/60">
            {isLoading && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-400">…</td>
              </tr>
            )}
            {!isLoading && clusters.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                  {tr('cluster.admin.empty', 'No clusters registered yet.')}
                </td>
              </tr>
            )}
            {clusters.map((c) => {
              const res = testResults[c.id]
              return (
                <tr key={c.id} className="text-white">
                  <td className="px-4 py-3">
                    {c.display_name}
                    {c.is_self_cluster && (
                      <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-300">self</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-300">{c.mode}</td>
                  <td className="px-4 py-3 text-slate-400 truncate max-w-[220px]">{c.api_server_url || '—'}</td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${healthDotClass(res ? (res.healthy ? 'healthy' : 'unhealthy') : c.health_status)}`} />
                      <span className="text-slate-300">
                        {res ? (res.healthy ? res.server_version || 'OK' : tr('cluster.admin.unhealthy', 'unhealthy')) : c.health_status || '—'}
                      </span>
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-400">{c.created_by || '—'}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => runTest(c.id)}
                        disabled={testingId === c.id}
                        className="flex items-center gap-1 rounded-lg border border-slate-600 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-700/40 disabled:opacity-50"
                        title={tr('cluster.admin.test', 'Test connection')}
                      >
                        {testingId === c.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Activity className="w-3.5 h-3.5" />}
                        {tr('cluster.admin.test', 'Test')}
                      </button>
                      <button
                        type="button"
                        data-testid={`delete-cluster-${c.id}`}
                        onClick={() => setDeleteTarget(c)}
                        className="flex items-center gap-1 rounded-lg border border-red-900/60 px-2.5 py-1.5 text-xs text-red-300 hover:bg-red-900/20"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        {tr('cluster.admin.delete', 'Delete')}
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {registerOpen && (
        <RegisterClusterDialog
          onClose={() => setRegisterOpen(false)}
          onRegistered={() => {
            setRegisterOpen(false)
            refresh()
          }}
        />
      )}

      {deleteTarget && (
        <ModalOverlay onClose={() => deleteMutation.isPending || setDeleteTarget(null)}>
          <div className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-800 p-6 shadow-2xl">
            <h3 className="text-lg font-bold text-white">{tr('cluster.delete.title', 'Delete cluster')}</h3>
            <p className="mt-2 text-sm text-slate-300">
              {tr('cluster.delete.confirm', 'Remove')} <span className="font-semibold text-white">{deleteTarget.display_name}</span>
              {deleteTarget.is_self_cluster
                ? ` — ${tr('cluster.delete.self', 'removed from the multi-cluster view only.')}`
                : ` — ${tr('cluster.delete.external', 'its stored kubeconfig is deleted too.')}`}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="rounded-lg px-4 py-2 text-sm text-slate-300 hover:bg-slate-700/40"
              >
                {tr('common.cancel', 'Cancel')}
              </button>
              <button
                type="button"
                data-testid="delete-confirm"
                onClick={() => deleteMutation.mutate(deleteTarget.id)}
                disabled={deleteMutation.isPending}
                className="flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-500 disabled:opacity-50"
              >
                {deleteMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                {tr('cluster.delete.submit', 'Delete')}
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}
    </div>
  )
}
