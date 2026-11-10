import { useState } from 'react'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, Activity, Loader2, Server, Pencil, Users } from 'lucide-react'

import { ModalOverlay } from '@/components/ModalOverlay'
import { ListPager } from '@/components/ListPager'
import { TableEmptyRow } from '@/components/TableEmptyRow'
import { AdaptiveTableFillerRows } from '@/components/AdaptiveTableFillerRows'
import { useAdaptiveTable } from '@/hooks/useAdaptiveTable'
import { pageOf } from '@/utils/listPages'
import { clustersApi, type ClusterMeta, type ConnectionResult } from '@/services/api/clusters'
import RegisterClusterDialog from './RegisterClusterDialog'
import EditClusterDialog from './EditClusterDialog'
import ClusterAccessModal from './ClusterAccessModal'
import { healthChecked, testOutcome, type TestOutcome } from './clusterTest'
import { healthDotClass } from '@/utils/clusterHealth'
import { failureText } from '@/utils/failureText'
import { RefreshFailure } from '@/components/RefreshFailure'
import { failureOf } from '@/hooks/useRefresh'

// Admin > Clusters (step 11): list every registered cluster with register /
// connection-test / delete. Registration & deletion are rollout-free, so the
// picker (clusters-accessible) is invalidated right after to reflect changes.
// The page is as high as the screen; the table pages the clusters, as many as
// fit (or the footer's fixed choice).
const CLUSTER_COLUMNS = 6

export default function AdminClusters() {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string) => t(key, { defaultValue: fallback })
  const queryClient = useQueryClient()

  const [registerOpen, setRegisterOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ClusterMeta | null>(null)
  const [editTarget, setEditTarget] = useState<ClusterMeta | null>(null)
  const [accessTarget, setAccessTarget] = useState<ClusterMeta | null>(null)
  const [testResults, setTestResults] = useState<Record<string, TestOutcome>>({})
  const [testing, setTesting] = useState<Record<string, boolean>>({})

  const { data: clusters = [], isLoading, error: listError, errorUpdatedAt, refetch: readAgain } = useQuery({
    queryKey: ['clusters-all'],
    queryFn: () => clustersApi.listClusters(false),
    staleTime: 30_000,
  })

  const [page, setPage] = useState(1)
  const { containerRef, bodyRef, theadRef, firstRowRef, rowsPerPage } = useAdaptiveTable({ recalculationKey: `${isLoading}:${clusters.length}` })
  const shown = pageOf(clusters, page, rowsPerPage)

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
    setTesting((p) => ({ ...p, [id]: true }))
    let res: ConnectionResult | null = null
    let err: unknown = null
    try {
      res = await clustersApi.testCluster(id)
    } catch (e) {
      err = e
    }
    const outcome = testOutcome(res, err, new Date().toISOString())
    // read the list again: the Health column is the health the test wrote
    await queryClient.refetchQueries({ queryKey: ['clusters-all'], exact: true })
    queryClient.invalidateQueries({ queryKey: ['clusters-accessible'] })
    setTestResults((p) => ({ ...p, [id]: outcome }))
    setTesting((p) => ({ ...p, [id]: false }))
  }

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] gap-4">
      <div className="page-head items-center shrink-0">
        <div>
          <h1 className="text-3xl font-semibold text-ink flex items-center gap-2">
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
          className="btn btn-primary flex items-center gap-2"
        >
          <Plus className="w-4 h-4" />
          {tr('cluster.admin.register', 'Register cluster')}
        </button>
      </div>

      <RefreshFailure failure={clusters.length ? failureOf(listError, errorUpdatedAt) : null} />

      <div ref={containerRef} className="card overflow-hidden p-0 flex-1 min-h-0 flex flex-col">
        {/* Horizontal scroll so the action buttons (Test/Access/Edit/Delete) are
            never clipped on a narrow / portrait viewport. */}
        <div ref={bodyRef} className="overflow-x-auto flex-1 min-h-0">
        <table data-testid="clusters-table" className="w-full text-sm min-w-[820px]">
          <thead ref={theadRef} className="bg-slate-900/40 text-slate-400">
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
            {!isLoading && clusters.length === 0 && <TableEmptyRow colSpan={CLUSTER_COLUMNS} resource="admin-clusters" error={listError} onRetry={() => void readAgain()} />}
            {shown.rows.map((c, idx) => {
              const tested = testResults[c.id]
              const testedText = tested
                ? `${tested.healthy ? tr('cluster.admin.testPassed', 'Test passed') : tr('cluster.admin.testFailed', 'Test failed')}${tested.detail ? `: ${tested.detail}` : ''}`
                : ''
              const checked = healthChecked(c.last_healthcheck_at)
              return (
                <tr key={c.id} ref={idx === 0 ? firstRowRef : undefined} className="text-ink">
                  <td className="px-4 py-3">
                    {c.display_name}
                    {c.is_self_cluster && (
                      <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-sm bg-slate-700 text-slate-300">self</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-300" title={c.mode}>{tr(`cluster.admin.modeValue.${c.mode}`, c.mode)}</td>
                  <td className="px-4 py-3 text-slate-400 truncate max-w-[220px]" title={c.api_server_url || undefined}>
                    {c.api_server_url || (c.is_self_cluster ? tr('cluster.admin.inCluster', 'In-cluster') : '-')}
                    {c.prometheus_url && (
                      <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-sm bg-slate-700 text-slate-300" title={c.prometheus_url} data-testid="cluster-prometheus-external">
                        {tr('cluster.admin.prometheusExternal', 'Prometheus: external')}
                      </span>
                    )}
                    {!c.prometheus_url && c.prometheus_service && (
                      <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-sm bg-slate-700 text-slate-300" title={c.prometheus_service} data-testid="cluster-prometheus-service">
                        {tr('cluster.admin.prometheusService', 'Prometheus: Service set')}
                      </span>
                    )}
                    {c.log_search_url && (
                      <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-sm bg-slate-700 text-slate-300" title={c.log_search_url} data-testid="cluster-logsearch-own">
                        {tr('cluster.admin.logSearchOwn', 'Log search: own store')}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${healthDotClass(c.health_status)}`} />
                      <span className="text-slate-300">
                        {c.health_status ? tr(`cluster.admin.healthValue.${c.health_status}`, c.health_status) : '-'}
                      </span>
                    </span>
                    {checked && (
                      <span className="block mt-0.5 text-xs text-slate-500 whitespace-nowrap" title={checked.title} data-testid={`cluster-health-checked-${c.id}`}>
                        {t('cluster.admin.healthChecked', { defaultValue: 'Checked {{time}}', time: checked.text })}
                      </span>
                    )}
                    <span role="status" className="block" data-testid={`cluster-test-result-${c.id}`}>
                      {tested && (
                        <span
                          className={`block mt-0.5 text-xs truncate max-w-[260px] ${tested.healthy ? 'text-green-400' : 'text-red-400'}`}
                          title={`${testedText}\n${healthChecked(tested.at)?.text ?? ''}`}
                        >
                          {testedText}
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-400">{c.created_by || '-'}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2 whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => runTest(c.id)}
                        disabled={testing[c.id]}
                        aria-busy={testing[c.id] || undefined}
                        className="btn-row"
                        title={tr('cluster.admin.test', 'Test connection')}
                      >
                        {testing[c.id] ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Activity className="w-3.5 h-3.5" />}
                        {tr('cluster.admin.test', 'Test')}
                      </button>
                      <button
                        type="button"
                        data-testid={`access-cluster-${c.id}`}
                        onClick={() => setAccessTarget(c)}
                        className="btn-row"
                        title={tr('cluster.admin.access', 'Manage access')}
                      >
                        <Users className="w-3.5 h-3.5" />
                        {tr('cluster.admin.access', 'Access')}
                      </button>
                      <button
                        type="button"
                        data-testid={`edit-cluster-${c.id}`}
                        onClick={() => setEditTarget(c)}
                        className="btn-row"
                        title={tr('cluster.admin.edit', 'Edit')}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                        {tr('cluster.admin.edit', 'Edit')}
                      </button>
                      <button
                        type="button"
                        data-testid={`delete-cluster-${c.id}`}
                        onClick={() => { deleteMutation.reset(); setDeleteTarget(c) }}
                        className="btn-row-danger"
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
          <AdaptiveTableFillerRows count={rowsPerPage - shown.rows.length} columnCount={CLUSTER_COLUMNS} />
        </table>
        </div>
        <ListPager currentPage={shown.page} totalPages={shown.pages} total={clusters.length} rowsPerPage={rowsPerPage} onPageChange={setPage} testId="clusters-pager" />
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

      {editTarget && (
        <EditClusterDialog
          cluster={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={() => {
            setEditTarget(null)
            refresh()
          }}
        />
      )}

      {accessTarget && (
        <ClusterAccessModal cluster={accessTarget} onClose={() => setAccessTarget(null)} />
      )}

      {deleteTarget && (
        <ModalOverlay onClose={() => deleteMutation.isPending || setDeleteTarget(null)}>
          <div className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-800 p-6 shadow-2xl">
            <h3 className="text-lg font-bold text-ink">{tr('cluster.delete.title', 'Delete cluster')}</h3>
            <p className="mt-2 text-sm text-slate-300">
              {tr('cluster.delete.confirm', 'Remove')} <span className="font-semibold text-ink">{deleteTarget.display_name}</span>
              {deleteTarget.is_self_cluster
                ? ` — ${tr('cluster.delete.self', 'removed from the multi-cluster view only.')}`
                : ` — ${tr('cluster.delete.external', 'its stored kubeconfig is deleted too.')}`}
            </p>
            {deleteMutation.isError && (
              <p role="alert" data-testid="delete-cluster-error" className="mt-3 text-sm text-red-400 break-words">
                {t('cluster.delete.failed', { defaultValue: 'Not deleted: {{reason}}', reason: failureText(deleteMutation.error) })}
              </p>
            )}
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
