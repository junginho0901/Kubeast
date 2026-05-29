import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { useKubeWatchList } from '@/services/useKubeWatchList'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import type { PodInfo } from '@/services/api'
import { applyPodWatchEvent } from '@/pages/workloads/pods/podWatchNormalize'
import { InfoSection, InfoRow, KeyValueTags, StatusBadge, fmtRel, fmtTs } from '../DetailCommon'

interface Props {
  name: string
  namespace?: string
  rawJson?: Record<string, unknown>
}

export default function ServiceDetail({ name, namespace, rawJson }: Props) {
  const { open: openDetail } = useResourceDetail()
  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const spec = (rawJson?.spec ?? {}) as Record<string, unknown>
  const status = (rawJson?.status ?? {}) as Record<string, unknown>
  const labels = (meta.labels ?? {}) as Record<string, string>
  const selector = (spec.selector ?? {}) as Record<string, string>
  const ports = (spec.ports ?? []) as any[]
  const externalIPs = (spec.externalIPs ?? []) as string[]
  const lbIngress = ((status.loadBalancer as any)?.ingress ?? []) as any[]

  const selectorStr = useMemo(
    () => Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(','),
    [selector],
  )
  const watchEnabled = !!namespace && !!selectorStr

  const { data: matchingPods } = useQuery({
    queryKey: ['service-matching-pods', namespace, name, selectorStr],
    queryFn: () => api.getPods(namespace as string, selectorStr),
    enabled: watchEnabled,
    staleTime: 5_000,
  })

  useKubeWatchList({
    enabled: watchEnabled,
    queryKey: ['service-matching-pods', namespace, name, selectorStr],
    path: `/api/v1/namespaces/${namespace}/pods`,
    query: `watch=1&labelSelector=${encodeURIComponent(selectorStr)}`,
    applyEvent: (prev, event) => applyPodWatchEvent(prev as PodInfo[] | undefined, event),
  })

  const pods = Array.isArray(matchingPods) ? matchingPods : []

  return (
    <>
      <InfoSection title="Service Info">
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          {namespace && <InfoRow label="Namespace" value={namespace} />}
          <InfoRow label="Type" value={String(spec.type ?? 'ClusterIP')} />
          <InfoRow label="Cluster IP" value={String(spec.clusterIP ?? '-')} />
          {externalIPs.length > 0 && <InfoRow label="External IPs" value={externalIPs.join(', ')} />}
          {lbIngress.length > 0 && <InfoRow label="Load Balancer" value={lbIngress.map((i: any) => i.ip || i.hostname).join(', ')} />}
          <InfoRow label="Session Affinity" value={String(spec.sessionAffinity ?? 'None')} />
          {spec.externalTrafficPolicy != null && <InfoRow label="External Traffic Policy" value={String(spec.externalTrafficPolicy)} />}
          {spec.internalTrafficPolicy != null && <InfoRow label="Internal Traffic Policy" value={String(spec.internalTrafficPolicy)} />}
          <InfoRow label="Created" value={meta.creationTimestamp ? `${fmtTs(meta.creationTimestamp as string)} (${fmtRel(meta.creationTimestamp as string)})` : '-'} />
        </div>
      </InfoSection>

      {Object.keys(selector).length > 0 && (
        <InfoSection title="Selector">
          <KeyValueTags data={selector} />
        </InfoSection>
      )}

      {ports.length > 0 && (
        <InfoSection title="Ports">
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[400px]">
              <thead className="text-slate-400"><tr><th className="text-left py-1">Name</th><th className="text-left py-1">Port</th><th className="text-left py-1">Target</th><th className="text-left py-1">Protocol</th>{spec.type === 'NodePort' && <th className="text-left py-1">NodePort</th>}</tr></thead>
              <tbody className="divide-y divide-slate-800">
                {ports.map((p: any, i: number) => (
                  <tr key={i} className="text-slate-200">
                    <td className="py-1 pr-2">{p.name || '-'}</td>
                    <td className="py-1 pr-2">{p.port}</td>
                    <td className="py-1 pr-2">{p.targetPort ?? '-'}</td>
                    <td className="py-1 pr-2">{p.protocol || 'TCP'}</td>
                    {spec.type === 'NodePort' && <td className="py-1 pr-2">{p.nodePort ?? '-'}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </InfoSection>
      )}

      {watchEnabled && (
        <InfoSection title={`Matching Pods (${pods.length})`}>
          {pods.length === 0 ? (
            <p className="text-xs text-slate-400">No pods match this selector.</p>
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
                  {pods.slice(0, 50).map((p) => (
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
              {pods.length > 50 && (
                <p className="text-[11px] text-slate-400 mt-1">Showing first 50 of {pods.length} pods.</p>
              )}
            </div>
          )}
        </InfoSection>
      )}

      {Object.keys(labels).length > 0 && <InfoSection title="Labels"><KeyValueTags data={labels} /></InfoSection>}
    </>
  )
}
