import { InfoSection, InfoRow, KeyValueTags, ConditionsTable, fmtRel, fmtTs } from './DetailCommon'

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

      {status && Object.keys(status).length > 0 && (
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

      {spec && Object.keys(spec).length > 0 && (
        <InfoSection title="Spec">
          <div className="space-y-2">
            {typeof spec.replicas === 'number' && <InfoRow label="Desired Replicas" value={String(spec.replicas)} />}
            {typeof spec.type === 'string' && <InfoRow label="Type" value={spec.type} />}
            {typeof spec.clusterIP === 'string' && <InfoRow label="Cluster IP" value={spec.clusterIP} />}
            {typeof spec.nodeName === 'string' && <InfoRow label="Node" value={spec.nodeName} />}
            {typeof spec.serviceAccountName === 'string' && <InfoRow label="Service Account" value={spec.serviceAccountName} />}
            {Array.isArray(spec.containers) && (
              <div className="mt-2">
                <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Containers</p>
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
                <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Ports</p>
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
          <div className="space-y-1 text-xs">
            {Object.entries(annotations).slice(0, 20).map(([k, v]) => (
              <div key={k} className="break-all">
                <span className="text-slate-500">{k}</span>
                <span className="text-slate-600 mx-1">=</span>
                <span className="text-slate-300">{String(v).slice(0, 200)}</span>
              </div>
            ))}
          </div>
        </InfoSection>
      )}
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
