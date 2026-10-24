import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ShieldCheck } from 'lucide-react'
import { api } from '@/services/api'
import type { NetpolDirection } from '@/services/api/types'
import { InfoSection } from './DetailCommon'
import { ResourceLink } from './ResourceLink'
import NetworkPolicyCheckModal from './NetworkPolicyCheckModal'
import { peerText, portsText, unevaluatedText, type Tr } from './netpolText'

// "Network Policies": the NetworkPolicies that select this pod (or a workload's pods by its template),
// per direction, with what their rules allow, and the window that checks one connection. Nothing is
// shown when the policies cannot be read.

function DirectionBlock({ title, dir, incoming, namespace, tr }: { title: string; dir: NetpolDirection; incoming: boolean; namespace: string; tr: Tr }) {
  return (
    <div className="space-y-1.5" data-testid={incoming ? 'netpol-ingress' : 'netpol-egress'}>
      <div className="text-xs font-medium text-slate-300">{title}</div>
      {!dir.isolated ? (
        <p className="text-xs text-slate-400" data-testid="netpol-not-isolated">{tr('netpolCheck.notIsolated', 'Not isolated: every connection is allowed.')}</p>
      ) : (
        <>
          <p className="text-xs text-amber-300" data-testid="netpol-isolated">
            {tr('netpolCheck.isolatedBy', 'Isolated by {{n}} policies: only what their rules allow.', { n: dir.policies.length })}
          </p>
          <ul className="space-y-1.5">
            {dir.policies.map((p) => (
              <li key={p.name} className="rounded-sm border border-slate-800 bg-slate-900/60 px-2.5 py-1.5 text-xs" data-testid="netpol-policy">
                <ResourceLink kind="NetworkPolicy" name={p.name} namespace={namespace} />
                {p.rules.length === 0 ? (
                  <span className="ml-2 text-red-300">{tr('netpolCheck.noRules', 'No rules: denies all.')}</span>
                ) : (
                  <ul className="mt-1 space-y-0.5 text-slate-300">
                    {p.rules.map((r, i) => (
                      <li key={i} data-testid="netpol-rule">
                        <span className="text-slate-500">{tr('netpolCheck.rule', 'Rule {{n}}', { n: i + 1 })} · </span>
                        {r.peers.length === 0
                          ? incoming ? tr('netpolCheck.fromAnywhere', 'from anywhere') : tr('netpolCheck.toAnywhere', 'to anywhere')
                          : r.peers.map((peer) => peerText(peer, tr)).join(' · ')}
                        <span className="text-slate-500"> — </span>
                        <span className="font-mono">{portsText(r.ports, tr)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

export default function NetworkPolicies({ kind, namespace, name }: { kind: string; namespace: string; name: string }) {
  const { t } = useTranslation()
  const tr: Tr = (key, fallback, options) => t(key, { defaultValue: fallback, ...options })
  const [checking, setChecking] = useState(false)
  const { data } = useQuery({
    queryKey: ['cluster', 'networkpolicies', 'effective', namespace, kind, name],
    queryFn: () => api.getEffectiveNetworkPolicies(namespace, kind, name),
    enabled: !!namespace && !!name,
    retry: false,
  })
  if (!data) return null
  const self = `${kind.toLowerCase()}/${namespace}/${name}`
  return (
    <InfoSection
      title="Network Policies"
      actions={
        <button
          type="button"
          onClick={() => setChecking(true)}
          data-testid="netpol-check-open"
          className="flex items-center gap-1 h-7 px-2.5 rounded-lg border border-slate-600 bg-slate-800 text-slate-200 text-[11px] hover:bg-slate-700 transition-colors"
        >
          <ShieldCheck className="w-3.5 h-3.5" />
          {tr('netpolCheck.open', 'Check a connection')}
        </button>
      }
    >
      <div className="space-y-3" data-testid="netpol-section">
        {data.host_network && <p className="text-xs text-amber-300">{tr('netpolCheck.hostNetwork', 'This pod uses the host network: whether policies apply to it depends on the network plugin.')}</p>}
        <DirectionBlock title={tr('netpolCheck.incoming', 'Incoming')} dir={data.ingress} incoming namespace={namespace} tr={tr} />
        <DirectionBlock title={tr('netpolCheck.outgoing', 'Outgoing')} dir={data.egress} incoming={false} namespace={namespace} tr={tr} />
        {data.unevaluated.length > 0 && (
          <p className="text-xs text-amber-300" data-testid="netpol-unevaluated">
            {tr('netpolCheck.unevaluated', 'Not part of this view: {{list}}. These can also allow or block connections.', { list: unevaluatedText(data.unevaluated, tr) })}
          </p>
        )}
      </div>
      {checking && <NetworkPolicyCheckModal self={self} selfName={name} namespace={namespace} onClose={() => setChecking(false)} />}
    </InfoSection>
  )
}
