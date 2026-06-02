import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import type { PodInfo } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { applyPodWatchEvent } from '@/pages/workloads/pods/podWatchNormalize'
import { InfoSection, InfoRow, KeyValueTags, StatusBadge, fmtRel, fmtTs, usePagination } from '../DetailCommon'

interface Props {
  name: string
  namespace?: string
  rawJson?: Record<string, unknown>
}

export default function NetworkPolicyDetail({ name, namespace, rawJson }: Props) {
  const { open: openDetail } = useResourceDetail()
  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const spec = (rawJson?.spec ?? {}) as Record<string, unknown>
  const labels = (meta.labels ?? {}) as Record<string, string>
  const annotations = (meta.annotations ?? {}) as Record<string, string>
  const finalizers = (meta.finalizers ?? rawJson?.finalizers ?? []) as string[]
  const podSelector = (spec.podSelector as any)?.matchLabels as Record<string, string> | undefined

  const selectorStr = useMemo(
    () => (podSelector ? Object.entries(podSelector).map(([k, v]) => `${k}=${v}`).join(',') : ''),
    [podSelector],
  )
  const watchEnabled = !!namespace && !!selectorStr

  const { data: affectedPods } = useQuery({
    queryKey: ['networkpolicy-affected-pods', namespace, name, selectorStr],
    queryFn: () => api.getPods(namespace as string, selectorStr),
    enabled: watchEnabled,
    staleTime: 5_000,
  })

  useKubeWatchList({
    enabled: watchEnabled,
    queryKey: ['networkpolicy-affected-pods', namespace, name, selectorStr],
    path: `/api/v1/namespaces/${namespace}/pods`,
    query: `watch=1&labelSelector=${encodeURIComponent(selectorStr)}`,
    applyEvent: (prev, event) => applyPodWatchEvent(prev as PodInfo[] | undefined, event),
  })

  const pods = Array.isArray(affectedPods) ? affectedPods : []
  const { items: pagedPods, nav: podsNav } = usePagination(pods, 10)
  const ingress = (spec.ingress ?? []) as any[]
  const egress = (spec.egress ?? []) as any[]
  const policyTypes = (spec.policyTypes ?? []) as string[]

  const isDefaultDenyIngress = policyTypes.includes('Ingress') && (!spec.ingress || (Array.isArray(spec.ingress) && (spec.ingress as any[]).length === 0))
  const isDefaultDenyEgress = policyTypes.includes('Egress') && (!spec.egress || (Array.isArray(spec.egress) && (spec.egress as any[]).length === 0))

  const renderPeer = (peer: any) => {
    const parts: string[] = []
    if (peer.ipBlock) parts.push(`CIDR: ${peer.ipBlock.cidr}${peer.ipBlock.except ? ` (except ${peer.ipBlock.except.join(', ')})` : ''}`)
    if (peer.namespaceSelector?.matchLabels) parts.push(`ns: ${Object.entries(peer.namespaceSelector.matchLabels).map(([k, v]) => `${k}=${v}`).join(',')}`)
    if (peer.podSelector?.matchLabels) parts.push(`pod: ${Object.entries(peer.podSelector.matchLabels).map(([k, v]) => `${k}=${v}`).join(',')}`)
    return parts.join(' | ') || '*'
  }

  // egress to[] 의 namespaceSelector 만 별도 인라인 태그로 강조 (k=v 쌍 단위)
  const renderEgressNsTags = (peer: any) => {
    const matchLabels = peer?.namespaceSelector?.matchLabels as Record<string, string> | undefined
    if (!matchLabels || Object.keys(matchLabels).length === 0) return null
    return (
      <span className="inline-flex flex-wrap gap-1 ml-1">
        {Object.entries(matchLabels).map(([k, v]) => (
          <span key={`${k}=${v}`} className="inline-flex rounded border border-cyan-700/50 bg-cyan-900/30 px-1.5 py-0.5 text-[10px] font-mono text-cyan-200">
            ns:{k}={v}
          </span>
        ))}
      </span>
    )
  }

  return (
    <>
      <InfoSection title="NetworkPolicy Info">
        {(isDefaultDenyIngress || isDefaultDenyEgress) && (
          <div className="flex flex-wrap gap-2 mb-3">
            {isDefaultDenyIngress && <span className="badge badge-warning">Default Deny Ingress</span>}
            {isDefaultDenyEgress && <span className="badge badge-warning">Default Deny Egress</span>}
          </div>
        )}
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          {namespace && <InfoRow label="Namespace" value={namespace} />}
          <InfoRow label="Policy Types" value={policyTypes.join(', ') || '-'} />
          <InfoRow label="Created" value={meta.creationTimestamp ? `${fmtTs(meta.creationTimestamp as string)} (${fmtRel(meta.creationTimestamp as string)})` : '-'} />
        </div>
      </InfoSection>

      {podSelector && Object.keys(podSelector).length > 0 && (
        <InfoSection title="Pod Selector">
          <KeyValueTags data={podSelector} />
        </InfoSection>
      )}

      {ingress.length > 0 && (
        <InfoSection title="Ingress Rules">
          <div className="space-y-2 text-xs">
            {ingress.map((rule: any, i: number) => (
              <div key={i} className="rounded border border-slate-800 p-2">
                {rule.ports?.length > 0 && <div className="text-slate-400">Ports: {rule.ports.map((p: any) => `${p.port}/${p.protocol || 'TCP'}`).join(', ')}</div>}
                <div className="text-slate-200">From: {(rule.from || [{ ipBlock: { cidr: '0.0.0.0/0' } }]).map(renderPeer).join(' ; ')}</div>
              </div>
            ))}
          </div>
        </InfoSection>
      )}

      {egress.length > 0 && (
        <InfoSection title="Egress Rules">
          <div className="space-y-2 text-xs">
            {egress.map((rule: any, i: number) => {
              const peers: any[] = rule.to || [{ ipBlock: { cidr: '0.0.0.0/0' } }]
              return (
                <div key={i} className="rounded border border-slate-800 p-2">
                  {rule.ports?.length > 0 && <div className="text-slate-400">Ports: {rule.ports.map((p: any) => `${p.port}/${p.protocol || 'TCP'}`).join(', ')}</div>}
                  <div className="text-slate-200">To: {peers.map(renderPeer).join(' ; ')}</div>
                  {peers.some((p) => p?.namespaceSelector?.matchLabels) && (
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      {peers.map((peer, pi) => {
                        const tags = renderEgressNsTags(peer)
                        return tags ? <span key={pi}>{tags}</span> : null
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </InfoSection>
      )}

      {watchEnabled && (
        <InfoSection title={`Affected Pods (${pods.length})`}>
          {pods.length === 0 ? (
            <p className="text-xs text-slate-400">No pods match this podSelector.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-slate-400">
                  <tr>
                    <th className="text-left py-1">Pod</th>
                    <th className="text-left py-1">Status</th>
                    <th className="text-left py-1">Ready</th>
                    <th className="text-left py-1">Restarts</th>
                    <th className="text-left py-1">Node</th>
                    <th className="text-left py-1">Age</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {pagedPods.map((p) => (
                    <tr
                      key={`${p.namespace}/${p.name}`}
                      className="text-slate-200 hover:bg-slate-800/40 cursor-pointer"
                      onClick={() => openDetail({ kind: 'Pod', name: p.name, namespace: p.namespace })}
                    >
                      <td className="py-1 pr-2 font-mono">{p.name}</td>
                      <td className="py-1 pr-2"><StatusBadge status={String((p as any).phase ?? (p as any).status ?? '-')} /></td>
                      <td className="py-1 pr-2">{(p as any).ready ?? '-'}</td>
                      <td className="py-1 pr-2">{String((p as any).restart_count ?? 0)}</td>
                      <td className="py-1 pr-2 truncate max-w-[160px]">{(p as any).node_name || '-'}</td>
                      <td className="py-1 pr-2 text-slate-400">{fmtRel((p as any).created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {podsNav}
            </div>
          )}
        </InfoSection>
      )}

      {Object.keys(labels).length > 0 && <InfoSection title="Labels"><KeyValueTags data={labels} /></InfoSection>}
      {Object.keys(annotations).length > 0 && <InfoSection title="Annotations"><KeyValueTags data={annotations} /></InfoSection>}
      {finalizers.length > 0 && (
        <InfoSection title="Finalizers">
          <div className="flex flex-wrap gap-1.5">
            {finalizers.map((f, i) => (
              <span key={`${f}-${i}`} className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-xs text-slate-200">{f}</span>
            ))}
          </div>
        </InfoSection>
      )}
    </>
  )
}
