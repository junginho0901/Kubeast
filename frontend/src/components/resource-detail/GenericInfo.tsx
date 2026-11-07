import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { InfoSection, InfoRow, KeyValueTags, ConditionsTable, EventsSection, Tx } from './DetailCommon'
import { fmtRel, fmtTs } from './detailFormat'
import { genericObjectLayer } from './drawerObjectLayer'
import { kindToPlural } from './utils'
import { useResourceDetailOverlay } from '@/hooks/useResourceDetailOverlay'

interface Props {
  name: string
  namespace?: string
  kind: string
  rawJson?: Record<string, unknown>
}

export default function GenericInfo({ name, namespace, kind, rawJson }: Props) {
  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const spec = (rawJson?.spec ?? {}) as Record<string, unknown>
  const status = (rawJson?.status ?? {}) as Record<string, unknown>
  const labels = (meta.labels ?? {}) as Record<string, string>
  const annotations = (meta.annotations ?? {}) as Record<string, string>

  // the events kubectl describe lists about the object; of the object's own group where a Kind has two
  const group = typeof rawJson?.apiVersion === 'string' && rawJson.apiVersion.includes('/') ? rawJson.apiVersion.split('/')[0] : ''
  const { data: describe, isLoading, error } = useQuery({
    queryKey: ['generic-describe', kind, namespace, name],
    queryFn: () => api.describeGenericResource(group ? `${kindToPlural(kind)}.${group}` : kindToPlural(kind), name, namespace),
    enabled: !!name,
    retry: false,
  })
  const refused = (error as { response?: { data?: { detail?: string } } } | null)?.response?.data?.detail

  const layer = useMemo(() => genericObjectLayer(rawJson, describe), [rawJson, describe])
  useResourceDetailOverlay({ kind, name, namespace, extras: layer })

  // the fields this view knows how to show; a section with none of them is left out (the YAML tab has the rest)
  const statusShown = typeof status.phase === 'string' || typeof status.replicas === 'number' || Array.isArray(status.conditions)
  const specShown = typeof spec.replicas === 'number' || ['type', 'clusterIP', 'nodeName', 'serviceAccountName'].some((k) => typeof spec[k] === 'string') ||
    Array.isArray(spec.containers) || Array.isArray(spec.ports)

  return (
    <>
      <InfoSection title="Basic Info">
        <div className="space-y-2">
          <InfoRow label="Kind" value={kind} />
          <InfoRow label="Name" value={name} />
          {namespace && <InfoRow label="Namespace" value={namespace} />}
          <InfoRow label="API Version" value={String(rawJson?.apiVersion ?? '-')} />
          <InfoRow label="Created" value={meta.creationTimestamp ? `${fmtTs(meta.creationTimestamp as string)} (${fmtRel(meta.creationTimestamp as string)})` : '-'} />
          {typeof meta.uid === 'string' && <InfoRow label="UID" value={<span className="font-mono text-[11px]">{meta.uid}</span>} />}
        </div>
      </InfoSection>

      {statusShown && (
        <InfoSection title="Status">
          <div className="space-y-2">
            {typeof status.phase === 'string' && (
              <InfoRow label="Phase" value={<span className={`badge ${phaseColor(status.phase)}`}>{status.phase}</span>} />
            )}
            {typeof status.replicas === 'number' && (
              <InfoRow label="Replicas" value={`${(status.readyReplicas as number) ?? 0}/${status.replicas}`} />
            )}
            {Array.isArray(status.conditions) && (
              <div className="mt-2">
                <ConditionsTable conditions={status.conditions as any[]} />
              </div>
            )}
          </div>
        </InfoSection>
      )}

      {specShown && (
        <InfoSection title="Spec">
          <div className="space-y-2">
            {typeof spec.replicas === 'number' && <InfoRow label="Desired Replicas" value={String(spec.replicas)} />}
            {typeof spec.type === 'string' && <InfoRow label="Type" value={spec.type} />}
            {typeof spec.clusterIP === 'string' && <InfoRow label="Cluster IP" value={spec.clusterIP} />}
            {typeof spec.nodeName === 'string' && <InfoRow label="Node" value={spec.nodeName} />}
            {typeof spec.serviceAccountName === 'string' && <InfoRow label="Service Account" value={spec.serviceAccountName} />}
            {Array.isArray(spec.containers) && (
              <div className="mt-2">
                <p className="text-xs text-slate-500 mb-1"><Tx>Containers</Tx></p>
                <div className="space-y-1">
                  {(spec.containers as any[]).map((c: any, i: number) => (
                    <div key={i} className="text-xs text-slate-300">
                      <span className="font-medium">{c.name}</span>
                      <span className="text-slate-500 ml-2">{c.image}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {Array.isArray(spec.ports) && (
              <div className="mt-2">
                <p className="text-xs text-slate-500 mb-1"><Tx>Ports</Tx></p>
                {(spec.ports as any[]).map((p: any, i: number) => (
                  <div key={i} className="text-xs text-slate-300">
                    {p.name && <span className="font-medium">{p.name}: </span>}
                    {p.port}{p.targetPort ? ` → ${p.targetPort}` : ''} {p.protocol && `(${p.protocol})`}
                  </div>
                ))}
              </div>
            )}
          </div>
        </InfoSection>
      )}

      {Object.keys(labels).length > 0 && (
        <InfoSection title="Labels">
          <KeyValueTags data={labels} />
        </InfoSection>
      )}

      {Object.keys(annotations).length > 0 && (
        <InfoSection title="Annotations">
          <KeyValueTags data={annotations} />
        </InfoSection>
      )}

      <EventsSection events={describe?.events} error={describe?.events_error ?? refused} loading={isLoading} />
    </>
  )
}

function phaseColor(phase: string) {
  const p = phase.toLowerCase()
  if (['running', 'active', 'bound', 'succeeded'].includes(p)) return 'badge-success'
  if (['pending'].includes(p)) return 'badge-warning'
  if (['failed', 'error', 'crashloopbackoff'].includes(p)) return 'badge-error'
  return 'badge-info'
}
