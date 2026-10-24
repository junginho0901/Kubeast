import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'
import { api } from '@/services/api'
import { useCluster } from '@/contexts/ClusterContext'
import { useClusterFeatures } from '@/hooks/usePrometheusQuery'
import { usePermission } from '@/hooks/usePermission'
import CustomDropdown from '@/components/CustomDropdown'
import { InfoSection } from './DetailCommon'
import NetworkPolicyCheckModal, { type NetpolCheckInitial } from './NetworkPolicyCheckModal'
import { checkInitial, peerLabel, rows } from './netdropText'

// "Network Drops": the drops the cluster's Hubble agents counted for this pod or workload (Prometheus
// hubble_drop_total) — how many, why and from or to whom. A metrics read like the drawer graphs, so it loads
// on its own; hidden where the cluster has no Prometheus or no drop metric. A policy drop opens the
// NetworkPolicy check for that peer.

export default function NetworkDrops({ kind, namespace, name }: { kind: string; namespace: string; name: string }) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, unknown>) => t(key, { defaultValue: fallback, ...options })
  const { currentCluster } = useCluster()
  const features = useClusterFeatures().data
  const { has } = usePermission()
  const [range, setRange] = useState('1h')
  const [why, setWhy] = useState<NetpolCheckInitial | null>(null)
  const on = features?.prometheus?.enabled === true && has('resource.networkflow.read')
  const drops = useQuery({
    queryKey: ['cluster', 'networkdrops', currentCluster, namespace, kind, name, range],
    queryFn: () => api.getNetworkDrops(namespace, { kind, name, range }),
    enabled: on,
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  })
  const res = drops.data
  if (!on || !res || (!res.available && res.reason !== 'no_context_labels')) return null
  const list = res.available ? rows(res) : []
  const notes = new Set(res.notes ?? [])
  return (
    <InfoSection
      title="Network Drops"
      actions={res.available ? (
        <div className="flex items-center gap-2">
          <CustomDropdown
            size="sm"
            value={range}
            onChange={setRange}
            options={['15m', '1h', '6h', '24h'].map((v) => ({ value: v, label: tr('netdrops.range', 'last {{w}}', { w: v }), testId: `netdrop-range-opt-${v}` }))}
            testId="netdrop-range"
          />
          <button type="button" onClick={() => drops.refetch()} className="h-8 w-8 inline-flex items-center justify-center rounded-lg border border-slate-600 bg-slate-800 text-slate-200 hover:bg-slate-700" aria-label={tr('netdrops.refresh', 'Refresh')} data-testid="netdrop-refresh">
            <RefreshCw className={`w-3.5 h-3.5 ${drops.isFetching ? 'animate-spin' : ''}`} />
          </button>
        </div>
      ) : undefined}
    >
      <div className="space-y-2 text-xs" data-testid="netdrop-section">
        {!res.available ? (
          <p className="text-slate-400" data-testid="netdrop-no-labels">{tr('netdrops.noLabels', "The cluster's Hubble drop metric has no pod or workload labels, so drops cannot be shown per workload. See the cluster requirements (Hubble metrics).")}</p>
        ) : (
          <>
            <p className="text-slate-300" data-testid="netdrop-totals">
              {tr('netdrops.totals', 'Incoming {{in}} · Outgoing {{out}} in the last {{w}}', { in: res.incoming.total, out: res.outgoing.total, w: range })}
            </p>
            {list.length === 0 ? (
              <p className="text-slate-400" data-testid="netdrop-none">{tr('netdrops.none', 'No drops in the last {{w}}.', { w: range })}</p>
            ) : (
              <table className="w-full" data-testid="netdrop-table">
                <thead className="text-slate-400">
                  <tr>
                    <th className="text-left py-1 pr-2 font-medium" />
                    <th className="text-left py-1 pr-2 font-medium">{tr('netdrops.peer', 'Peer')}</th>
                    <th className="text-left py-1 pr-2 font-medium">{tr('netdrops.reason', 'Reason')}</th>
                    <th className="text-left py-1 font-medium">{tr('netdrops.count', 'Drops')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {list.map((r, i) => {
                    const init = checkInitial(r)
                    return (
                      <tr key={i} className="text-slate-200 align-top" data-testid="netdrop-row">
                        <td className="py-1.5 pr-2 whitespace-nowrap text-slate-400">{r.direction === 'incoming' ? tr('netdrops.in', 'in') : tr('netdrops.out', 'out')}</td>
                        <td className="py-1.5 pr-2 font-mono break-all" data-testid="netdrop-peer">{peerLabel(r, namespace) || tr('netdrops.unknownPeer', 'outside the cluster or unknown')}</td>
                        <td className="py-1.5 pr-2 text-red-300 break-all" data-testid="netdrop-reason">
                          {r.reason}
                          {init && (
                            <button type="button" className="ml-2 text-blue-400 hover:text-blue-300 hover:underline" onClick={() => setWhy(init)} data-testid="netdrop-why">
                              {tr('netdrops.why', 'Why?')}
                            </button>
                          )}
                        </td>
                        <td className="py-1.5 whitespace-nowrap" data-testid="netdrop-count">{r.count}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
            {notes.has('workload_level') && res.workload && (
              <p className="text-slate-500" data-testid="netdrop-workload-level">{tr('netdrops.workloadLevel', 'The metric has no pod label: these are the drops of {{workload}}.', { workload: `${res.workload.kind}/${res.workload.name}` })}</p>
            )}
            {notes.has('no_workload') && <p className="text-slate-500">{tr('netdrops.noWorkload', 'This pod has no workload and the metric has no pod label, so its drops cannot be told apart.')}</p>}
            {notes.has('pods_truncated') && <p className="text-slate-500">{tr('netdrops.podsTruncated', 'Only the first 50 pods are counted.')}</p>}
            {res.redacted && <p className="text-slate-500">{tr('netdrops.redacted', 'Peers outside your namespaces show their namespace only.')}</p>}
            <p className="text-slate-500">{tr('netdrops.source', 'Counted by the Hubble agents (Prometheus), one per dropped packet.')}</p>
          </>
        )}
      </div>
      {why && <NetworkPolicyCheckModal self={`${kind.toLowerCase()}/${namespace}/${name}`} selfName={name} namespace={namespace} initial={why} onClose={() => setWhy(null)} />}
    </InfoSection>
  )
}
