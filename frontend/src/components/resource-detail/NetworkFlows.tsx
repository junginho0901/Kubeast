import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'
import { api } from '@/services/api'
import type { NetflowGroup } from '@/services/api/types'
import { useCluster } from '@/contexts/ClusterContext'
import { useClusterFeatures } from '@/hooks/usePrometheusQuery'
import { usePermission } from '@/hooks/usePermission'
import { networkFlowsEnabledFor } from '@/utils/features'
import { formatAge } from '@/utils/time'
import CustomDropdown from '@/components/CustomDropdown'
import { InfoSection, NoneText } from './DetailCommon'
import NetworkPolicyCheckModal, { type NetpolCheckInitial } from './NetworkPolicyCheckModal'
import { checkInitial, endLabel, isSelf, policyRefs, type FlowSelf } from './netflowText'

// "Recent Flows": the connections the cluster's Hubble Relay saw to and from this pod or workload, folded
// per connection. A sensitive read (audited), so it loads when asked. A dropped connection opens the
// NetworkPolicy check for it, which names the rule.

type Tr = (key: string, fallback: string, options?: Record<string, unknown>) => string

const VERDICT_BADGE: Record<string, string> = { FORWARDED: 'badge-success', DROPPED: 'badge-error', ERROR: 'badge-error', AUDIT: 'badge-warning' }

function GroupRow({ g, self, tr, onWhy }: { g: NetflowGroup; self: FlowSelf; tr: Tr; onWhy: (init: NetpolCheckInitial) => void }) {
  const incoming = isSelf(g.destination, self)
  const peer = incoming ? g.source : g.destination
  const refs = policyRefs(g)
  const why = g.verdict === 'DROPPED' ? checkInitial(g, self) : null
  return (
    <tr className="text-slate-200 align-top" data-testid="netflow-row">
      <td className="py-1.5 pr-2"><span className={`badge ${VERDICT_BADGE[g.verdict] || 'badge-neutral'}`} data-testid="netflow-verdict">{g.verdict}</span></td>
      <td className="py-1.5 pr-2 whitespace-nowrap text-slate-400">{incoming ? tr('netflows.in', 'in') : tr('netflows.out', 'out')}</td>
      <td className="py-1.5 pr-2 font-mono break-all" data-testid="netflow-peer">{endLabel(peer, self.namespace)}</td>
      <td className="py-1.5 pr-2 font-mono whitespace-nowrap">{g.protocol || '-'} {g.destination.port || ''}</td>
      <td className="py-1.5 pr-2 whitespace-nowrap" title={tr('netflows.repliesTitle', '{{n}} replies', { n: g.replies, count: g.replies })}>{g.count}</td>
      <td className="py-1.5 pr-2 whitespace-nowrap text-slate-400" title={g.last}>{formatAge(g.last)}</td>
      <td className="py-1.5 text-slate-300 break-words">
        {g.drop_reason && <span className="text-red-300" data-testid="netflow-reason">{g.drop_reason}</span>}
        {refs.allowed.length > 0 && <span className="text-slate-400">{tr('netflows.allowedBy', 'allowed by {{list}}', { list: refs.allowed.join(', ') })}</span>}
        {refs.denied.length > 0 && <span className="text-red-300">{tr('netflows.deniedBy', 'denied by {{list}}', { list: refs.denied.join(', ') })}</span>}
        {why && (
          <button type="button" className="ml-2 text-blue-400 hover:text-blue-300 hover:underline" onClick={() => onWhy(why)} data-testid="netflow-why">
            {tr('netflows.why', 'Why?')}
          </button>
        )}
      </td>
    </tr>
  )
}

export default function NetworkFlows({ kind, namespace, name }: { kind: string; namespace: string; name: string }) {
  const { t } = useTranslation()
  const tr: Tr = (key, fallback, options) => t(key, { defaultValue: fallback, ...options })
  const { currentCluster } = useCluster()
  const features = useClusterFeatures().data
  const { has } = usePermission()
  const [asked, setAsked] = useState(false)
  const [since, setSince] = useState('15m')
  const [dropsOnly, setDropsOnly] = useState(false)
  const [why, setWhy] = useState<NetpolCheckInitial | null>(null)
  const on = networkFlowsEnabledFor(features, currentCluster) && has('resource.networkflow.read')
  const calico = features?.networkFlows?.providers?.[currentCluster] === 'calico'
  const self: FlowSelf = { kind, namespace, name }
  const flows = useQuery({
    queryKey: ['cluster', 'networkflows', namespace, kind, name, since, dropsOnly],
    queryFn: () => api.getNetworkFlows(namespace, { kind, name, since, verdict: dropsOnly ? 'DROPPED' : undefined }),
    enabled: on && asked,
    retry: false,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  })
  if (!on) return null
  const res = flows.data
  const errorText = (flows.error as any)?.response?.data?.detail ?? (flows.error as Error | null)?.message
  return (
    <InfoSection
      title="Recent Flows"
      actions={asked ? (
        <div className="flex items-center gap-2">
          <CustomDropdown
            size="sm"
            value={since}
            onChange={setSince}
            options={['5m', '15m', '1h'].map((v) => ({ value: v, label: tr('netflows.window', 'last {{w}}', { w: v }), testId: `netflow-window-opt-${v}` }))}
            testId="netflow-window"
          />
          <CustomDropdown
            size="sm"
            value={dropsOnly ? 'dropped' : 'all'}
            onChange={(v) => setDropsOnly(v === 'dropped')}
            options={[
              { value: 'all', label: tr('netflows.all', 'All'), testId: 'netflow-verdict-opt-all' },
              { value: 'dropped', label: tr('netflows.droppedOnly', 'Dropped only'), testId: 'netflow-verdict-opt-dropped' },
            ]}
            testId="netflow-verdict-filter"
          />
          <button type="button" onClick={() => flows.refetch()} className="h-8 w-8 inline-flex items-center justify-center rounded-lg border border-slate-600 bg-slate-800 text-slate-200 hover:bg-slate-700" aria-label={tr('netflows.refresh', 'Refresh')} data-testid="netflow-refresh">
            <RefreshCw className={`w-3.5 h-3.5 ${flows.isFetching ? 'animate-spin' : ''}`} />
          </button>
        </div>
      ) : undefined}
    >
      <div className="space-y-2 text-xs" data-testid="netflow-section">
        {!asked ? (
          <div className="flex items-center gap-3">
            <p className="text-slate-400">
              {calico
                ? tr('netflows.introCalico', "Connections Calico's Whisker saw to and from this {{kind}}, counted in packets. Calico names the pods of one ReplicaSet or Job together. Reading them is recorded in the audit log.", { kind })
                : tr('netflows.intro', "Connections the cluster's Hubble Relay saw to and from this {{kind}}. Reading them is recorded in the audit log.", { kind })}
            </p>
            <button type="button" className="shrink-0 h-7 px-2.5 rounded-lg border border-slate-600 bg-slate-800 text-slate-200 text-[11px] hover:bg-slate-700" onClick={() => setAsked(true)} data-testid="netflow-load">
              {tr('netflows.load', 'Show flows')}
            </button>
          </div>
        ) : flows.isLoading ? (
          <p className="text-slate-400">{tr('common.loading', 'Loading...')}</p>
        ) : errorText ? (
          <p className="text-red-300 break-words" data-testid="netflow-error">{errorText}</p>
        ) : !res || res.groups.length === 0 ? (
          <div data-testid="netflow-none"><NoneText /></div>
        ) : (
          <table className="w-full" data-testid="netflow-table">
            <thead className="text-slate-400">
              <tr>
                <th className="text-left py-1 pr-2 font-medium">{tr('netflows.verdict', 'Verdict')}</th>
                <th className="text-left py-1 pr-2 font-medium" />
                <th className="text-left py-1 pr-2 font-medium">{tr('netflows.peer', 'Peer')}</th>
                <th className="text-left py-1 pr-2 font-medium">{tr('netflows.port', 'Port')}</th>
                <th className="text-left py-1 pr-2 font-medium">{tr('netflows.count', 'Flows')}</th>
                <th className="text-left py-1 pr-2 font-medium">{tr('netflows.last', 'Last')}</th>
                <th className="text-left py-1 font-medium">{tr('netflows.reason', 'Reason · policy')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {res.groups.map((g, i) => <GroupRow key={i} g={g} self={self} tr={tr} onWhy={setWhy} />)}
            </tbody>
          </table>
        )}
        {res && res.truncated && <p className="text-slate-500">{tr('netflows.truncated', 'The Relay had more flows than were read ({{n}}); a shorter window shows the most recent ones.', { n: res.flows.length })}</p>}
        {res?.redacted && <p className="text-slate-500">{tr('netflows.redacted', 'Peers outside your namespaces show their namespace and address only.')}</p>}
        {res && (res.lost_events ?? 0) > 0 && <p className="text-amber-300">{tr('netflows.lost', 'Hubble reported {{n}} lost events: some flows may be missing.', { n: res.lost_events, count: res.lost_events })}</p>}
      </div>
      {why && <NetworkPolicyCheckModal self={`${kind.toLowerCase()}/${namespace}/${name}`} selfName={name} namespace={namespace} initial={why} onClose={() => setWhy(null)} />}
    </InfoSection>
  )
}
