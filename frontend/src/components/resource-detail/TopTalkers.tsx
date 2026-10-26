import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'
import { api } from '@/services/api'
import type { NfmMetric, NfmView } from '@/services/api/types'
import { useCluster } from '@/contexts/ClusterContext'
import { useClusterFeatures } from '@/hooks/usePrometheusQuery'
import { usePermission } from '@/hooks/usePermission'
import { networkFlowMonitorEnabledFor } from '@/utils/features'
import CustomDropdown from '@/components/CustomDropdown'
import { InfoSection, NoneText } from './DetailCommon'
import { formatValue, peerLabel, sides, zones, type TalkerSelf } from './topTalkersText'

// "Top Talkers": the top contributors of the cluster's Amazon CloudWatch Network Flow Monitor monitor with this
// pod or workload at either end, in the EKS console flow table's three views (within the cluster, to AWS
// services, to outside AWS). Kubeast reads them from AWS with its own identity and the read is audited, so it
// loads when asked.

const METRICS: NfmMetric[] = ['DATA_TRANSFERRED', 'RETRANSMISSIONS', 'TIMEOUTS']
const VIEWS: NfmView[] = ['cluster', 'aws', 'external']

export default function TopTalkers({ kind, namespace, name }: { kind: string; namespace: string; name: string }) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, options?: Record<string, unknown>) => t(key, { defaultValue: fallback, ...options })
  const { currentCluster } = useCluster()
  const features = useClusterFeatures().data
  const { has } = usePermission()
  const [asked, setAsked] = useState(false)
  const [view, setView] = useState<NfmView>('cluster')
  const [metric, setMetric] = useState<NfmMetric>('DATA_TRANSFERRED')
  const [range, setRange] = useState('1h')
  const on = networkFlowMonitorEnabledFor(features, currentCluster) && has('resource.networkflow.read')
  const self: TalkerSelf = { kind, namespace, name }
  const top = useQuery({
    queryKey: ['cluster', 'networktopflows', currentCluster, namespace, kind, name, view, metric, range],
    queryFn: () => api.getNetworkTopFlows(namespace, { kind, name, view, metric, range }),
    enabled: on && asked,
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  })
  if (!on) return null
  const res = top.data
  const errorText = (top.error as any)?.response?.data?.detail ?? (top.error as Error | null)?.message
  const metricLabel = (m: NfmMetric) =>
    m === 'DATA_TRANSFERRED' ? tr('toptalkers.metric.data', 'Data transferred') : m === 'RETRANSMISSIONS' ? tr('toptalkers.metric.retransmissions', 'Retransmissions') : tr('toptalkers.metric.timeouts', 'Retransmission timeouts')
  const category = (c: string) =>
    ({
      INTRA_AZ: tr('toptalkers.category.intraAz', 'same zone'),
      INTER_AZ: tr('toptalkers.category.interAz', 'across zones'),
      AMAZON_S3: 'Amazon S3',
      AMAZON_DYNAMODB: 'Amazon DynamoDB',
      UNCLASSIFIED: tr('toptalkers.category.unclassified', 'internet or on-premises'),
    })[c] ?? c
  return (
    <InfoSection
      title="Top Talkers"
      actions={asked ? (
        <div className="flex items-center gap-2">
          <CustomDropdown
            size="sm"
            value={view}
            onChange={(v) => setView(v as NfmView)}
            options={VIEWS.map((v) => ({
              value: v,
              label: v === 'cluster' ? tr('toptalkers.view.cluster', 'Within the cluster') : v === 'aws' ? tr('toptalkers.view.aws', 'AWS services') : tr('toptalkers.view.external', 'Outside AWS'),
              testId: `toptalkers-view-opt-${v}`,
            }))}
            testId="toptalkers-view"
          />
          <CustomDropdown
            size="sm"
            value={metric}
            onChange={(v) => setMetric(v as NfmMetric)}
            options={METRICS.map((m) => ({ value: m, label: metricLabel(m), testId: `toptalkers-metric-opt-${m}` }))}
            testId="toptalkers-metric"
          />
          <CustomDropdown
            size="sm"
            value={range}
            onChange={setRange}
            options={['15m', '1h', '2h'].map((v) => ({ value: v, label: tr('toptalkers.range', 'last {{w}}', { w: v }), testId: `toptalkers-range-opt-${v}` }))}
            testId="toptalkers-range"
          />
          <button type="button" onClick={() => top.refetch()} className="h-8 w-8 inline-flex items-center justify-center rounded-lg border border-slate-600 bg-slate-800 text-slate-200 hover:bg-slate-700" aria-label={tr('toptalkers.refresh', 'Refresh')} data-testid="toptalkers-refresh">
            <RefreshCw className={`w-3.5 h-3.5 ${top.isFetching ? 'animate-spin' : ''}`} />
          </button>
        </div>
      ) : undefined}
    >
      <div className="space-y-2 text-xs" data-testid="toptalkers-section">
        {!asked ? (
          <div className="flex items-center gap-3">
            <p className="text-slate-400">
              {tr('toptalkers.intro', "Who this {{kind}} exchanges the most data with, and where retransmissions happen, from the cluster's Network Flow Monitor (AWS). Reading them is recorded in the audit log.", { kind })}
            </p>
            <button type="button" className="shrink-0 h-7 px-2.5 rounded-lg border border-slate-600 bg-slate-800 text-slate-200 text-[11px] hover:bg-slate-700" onClick={() => setAsked(true)} data-testid="toptalkers-load">
              {tr('toptalkers.load', 'Show top talkers')}
            </button>
          </div>
        ) : top.isLoading ? (
          <p className="text-slate-400">{tr('common.loading', 'Loading...')}</p>
        ) : errorText ? (
          <p className="text-red-300 break-words" data-testid="toptalkers-error">{errorText}</p>
        ) : !res || res.rows.length === 0 ? (
          <div data-testid="toptalkers-none"><NoneText /></div>
        ) : (
          <table className="w-full" data-testid="toptalkers-table">
            <thead className="text-slate-400">
              <tr>
                <th className="text-left py-1 pr-2 font-medium">{tr('toptalkers.peer', 'Peer')}</th>
                {kind !== 'Pod' && <th className="text-left py-1 pr-2 font-medium">Pod</th>}
                <th className="text-left py-1 pr-2 font-medium">{tr('toptalkers.port', 'Port')}</th>
                <th className="text-left py-1 pr-2 font-medium">{metricLabel(res.metric)}</th>
                <th className="text-left py-1 pr-2 font-medium">{tr('toptalkers.zones', 'Zones')}</th>
                <th className="text-left py-1 font-medium">{tr('toptalkers.category.title', 'Category')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {res.rows.map((r, i) => {
                const { own, peer } = sides(r, self)
                return (
                  <tr key={i} className="text-slate-200 align-top" data-testid="toptalkers-row">
                    <td className="py-1.5 pr-2 font-mono break-all" title={peer.ip} data-testid="toptalkers-peer">{peerLabel(peer, namespace)}</td>
                    {kind !== 'Pod' && <td className="py-1.5 pr-2 font-mono break-all text-slate-400" data-testid="toptalkers-own">{own.pod || '-'}</td>}
                    <td className="py-1.5 pr-2 font-mono whitespace-nowrap">{r.port || '-'}</td>
                    <td className="py-1.5 pr-2 whitespace-nowrap" title={String(r.value)} data-testid="toptalkers-value">{formatValue(r.value, res.unit)}</td>
                    <td className="py-1.5 pr-2 whitespace-nowrap text-slate-400">{zones(own, peer)}</td>
                    <td className="py-1.5 whitespace-nowrap text-slate-400" data-testid="toptalkers-category">{category(r.category)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        {res?.truncated && <p className="text-slate-500">{tr('toptalkers.truncated', 'Network Flow Monitor gave as many rows as were asked in a category: this {{kind}} may have more than these.', { kind })}</p>}
        {res?.redacted && <p className="text-slate-500">{tr('toptalkers.redacted', 'Peers in namespaces whose pods you cannot list show their namespace and address only.')}</p>}
        {res && <p className="text-slate-500">{tr('toptalkers.source', 'Measured by the Network Flow Monitor agent on each node over the last {{w}}, monitor {{monitor}}. A connection between two pods can be listed once from each end.', { w: range, monitor: res.monitor })}</p>}
      </div>
    </InfoSection>
  )
}
