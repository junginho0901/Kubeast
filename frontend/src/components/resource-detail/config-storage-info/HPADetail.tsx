import { ConditionsTable, InfoSection, InfoRow, KeyValueTags, fmtRel, fmtTs } from '../DetailCommon'

export default function HPADetail({ name, namespace, rawJson }: { name: string; namespace?: string; rawJson?: Record<string, unknown> }) {
  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const spec = (rawJson?.spec ?? {}) as Record<string, unknown>
  const status = (rawJson?.status ?? {}) as Record<string, unknown>
  const labels = (meta.labels ?? {}) as Record<string, string>
  const annotations = (meta.annotations ?? {}) as Record<string, string>
  const scaleRef = spec.scaleTargetRef as Record<string, string> | undefined
  const metrics = (spec.metrics ?? []) as any[]
  const currentMetrics = (status.currentMetrics ?? []) as any[]
  const conditions = (status.conditions ?? []) as any[]
  const behavior = spec.behavior as Record<string, any> | undefined
  const lastScaleTime = status.lastScaleTime as string | undefined
  const currentReplicas = status.currentReplicas as number | undefined
  const desiredReplicas = status.desiredReplicas as number | undefined
  const replicasMismatch = currentReplicas != null && desiredReplicas != null && currentReplicas !== desiredReplicas

  /* Helper: resolve metric name & target/current for each metric type */
  const resolveMetricRow = (m: any, idx: number) => {
    const cur = currentMetrics[idx]
    const type = String(m.type ?? '-')
    let metricName = '-'
    let target = '-'
    let current = '-'

    if (type === 'Resource' && m.resource) {
      metricName = String(m.resource.name ?? '-')
      const tgt = m.resource.target ?? {}
      target = tgt.averageUtilization != null
        ? `${tgt.averageUtilization}% (avg util)`
        : tgt.averageValue != null ? String(tgt.averageValue) : String(tgt.value ?? '-')
      if (cur?.resource?.current) {
        const c = cur.resource.current
        current = c.averageUtilization != null
          ? `${c.averageUtilization}%`
          : c.averageValue != null ? String(c.averageValue) : '-'
      }
    } else if (type === 'Pods' && m.pods) {
      metricName = String(m.pods.metric?.name ?? '-')
      target = String(m.pods.target?.averageValue ?? '-')
      if (cur?.pods?.current) current = String(cur.pods.current.averageValue ?? '-')
    } else if (type === 'Object' && m.object) {
      metricName = String(m.object.metric?.name ?? '-')
      const tgt = m.object.target ?? {}
      target = tgt.value != null ? String(tgt.value) : tgt.averageValue != null ? String(tgt.averageValue) : '-'
      if (cur?.object?.current) {
        const c = cur.object.current
        current = c.value != null ? String(c.value) : c.averageValue != null ? String(c.averageValue) : '-'
      }
    } else if (type === 'External' && m.external) {
      metricName = String(m.external.metric?.name ?? '-')
      const tgt = m.external.target ?? {}
      target = tgt.value != null ? String(tgt.value) : tgt.averageValue != null ? String(tgt.averageValue) : '-'
      if (cur?.external?.current) {
        const c = cur.external.current
        current = c.value != null ? String(c.value) : c.averageValue != null ? String(c.averageValue) : '-'
      }
    }
    return { type, metricName, target, current }
  }

  /* Helper: render scaling behavior (scaleUp / scaleDown) */
  const renderBehaviorSection = (label: string, cfg: any) => {
    if (!cfg) return null
    const policies = Array.isArray(cfg.policies) ? cfg.policies : []
    return (
      <div className="rounded border border-slate-800 p-3">
        <p className="text-xs font-medium text-white mb-2">{label}</p>
        <div className="space-y-2">
          {cfg.stabilizationWindowSeconds != null && (
            <InfoRow label="Stabilization Window" value={`${cfg.stabilizationWindowSeconds}s`} />
          )}
          {cfg.selectPolicy && <InfoRow label="Select Policy" value={String(cfg.selectPolicy)} />}
          {policies.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs table-fixed min-w-[360px]">
                <thead className="text-slate-400">
                  <tr>
                    <th className="text-left py-2 w-[34%]">Type</th>
                    <th className="text-left py-2 w-[33%]">Value</th>
                    <th className="text-left py-2 w-[33%]">Period (s)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {policies.map((p: any, idx: number) => (
                    <tr key={idx} className="text-slate-200">
                      <td className="py-2 pr-2">{String(p.type ?? '-')}</td>
                      <td className="py-2 pr-2">{String(p.value ?? '-')}</td>
                      <td className="py-2 pr-2">{String(p.periodSeconds ?? '-')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <>
      <InfoSection title="HPA Info">
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          {namespace && <InfoRow label="Namespace" value={namespace} />}
          {scaleRef && (
            <InfoRow label="Scale Target" value={`${scaleRef.kind ?? '-'}/${scaleRef.name ?? '-'}${scaleRef.apiVersion ? ` (${scaleRef.apiVersion})` : ''}`} />
          )}
          <InfoRow label="Min Replicas" value={String(spec.minReplicas ?? 1)} />
          <InfoRow label="Max Replicas" value={String(spec.maxReplicas ?? '-')} />
          <InfoRow
            label="Current Replicas"
            value={
              <span className={replicasMismatch ? 'text-amber-300' : ''}>
                {String(currentReplicas ?? '-')}
              </span>
            }
          />
          <InfoRow
            label="Desired Replicas"
            value={
              <span className={replicasMismatch ? 'text-amber-300' : ''}>
                {String(desiredReplicas ?? '-')}
              </span>
            }
          />
          {lastScaleTime && (
            <InfoRow label="Last Scale Time" value={`${fmtTs(lastScaleTime)} (${fmtRel(lastScaleTime)})`} />
          )}
          <InfoRow label="Created" value={meta.creationTimestamp ? `${fmtTs(meta.creationTimestamp as string)} (${fmtRel(meta.creationTimestamp as string)})` : '-'} />
        </div>
      </InfoSection>

      {metrics.length > 0 && (
        <InfoSection title={`Metrics (${metrics.length})`}>
          <div className="overflow-x-auto">
            <table className="w-full text-xs table-fixed min-w-[520px]">
              <thead className="text-slate-400">
                <tr>
                  <th className="text-left py-2 w-[28%]">Metric Name</th>
                  <th className="text-left py-2 w-[18%]">Type</th>
                  <th className="text-left py-2 w-[27%]">Target</th>
                  <th className="text-left py-2 w-[27%]">Current</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {metrics.map((m: any, i: number) => {
                  const row = resolveMetricRow(m, i)
                  return (
                    <tr key={i} className="text-slate-200">
                      <td className="py-2 pr-2"><span className="block truncate" title={row.metricName}>{row.metricName}</span></td>
                      <td className="py-2 pr-2">{row.type}</td>
                      <td className="py-2 pr-2">{row.target}</td>
                      <td className="py-2 pr-2">{row.current}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </InfoSection>
      )}

      {behavior && (behavior.scaleUp || behavior.scaleDown) && (
        <InfoSection title="Scaling Behavior">
          <div className="space-y-3">
            {renderBehaviorSection('Scale Up', behavior.scaleUp)}
            {renderBehaviorSection('Scale Down', behavior.scaleDown)}
          </div>
        </InfoSection>
      )}

      {conditions.length > 0 && (
        <InfoSection title="Conditions">
          <ConditionsTable conditions={conditions} />
        </InfoSection>
      )}

      {Object.keys(labels).length > 0 && <InfoSection title="Labels"><KeyValueTags data={labels} /></InfoSection>}
      {Object.keys(annotations).length > 0 && <InfoSection title="Annotations"><KeyValueTags data={annotations} /></InfoSection>}
    </>
  )
}
