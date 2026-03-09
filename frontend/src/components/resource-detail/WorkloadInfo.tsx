import { InfoSection, InfoRow, InfoGrid, KeyValueTags, ConditionsTable, fmtRel, fmtTs } from './DetailCommon'

interface Props {
  name: string
  namespace?: string
  kind: string
  rawJson?: Record<string, unknown>
}

export default function WorkloadInfo({ name, namespace, kind, rawJson }: Props) {
  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const spec = (rawJson?.spec ?? {}) as Record<string, unknown>
  const status = (rawJson?.status ?? {}) as Record<string, unknown>
  const labels = (meta.labels ?? {}) as Record<string, string>
  const annotations = (meta.annotations ?? {}) as Record<string, string>

  const strategy = spec.strategy as Record<string, any> | undefined
  const updateStrategy = spec.updateStrategy as Record<string, any> | undefined
  const selector = (spec.selector as Record<string, any>)?.matchLabels as Record<string, string> | undefined
  const nodeSelector = spec.nodeSelector as Record<string, string> | undefined
  const podTemplate = (spec.template as Record<string, any>)?.spec as Record<string, unknown> | undefined
  const containers = (podTemplate?.containers ?? spec.containers ?? []) as any[]
  const conditions = (status.conditions ?? []) as any[]

  const isJob = kind === 'Job'
  const isCronJob = kind === 'CronJob'

  const cronSpec = isCronJob ? (spec.jobTemplate as Record<string, any>)?.spec as Record<string, unknown> | undefined : undefined
  const cronContainers = isCronJob ? ((cronSpec?.template as Record<string, any>)?.spec?.containers ?? []) as any[] : []

  return (
    <>
      {/* Basic Info */}
      <InfoSection title="Basic Info">
        <div className="space-y-2">
          <InfoRow label="Kind" value={kind} />
          <InfoRow label="Name" value={name} />
          {namespace && <InfoRow label="Namespace" value={namespace} />}
          <InfoRow label="Created" value={meta.creationTimestamp ? `${fmtTs(meta.creationTimestamp as string)} (${fmtRel(meta.creationTimestamp as string)})` : '-'} />
        </div>
      </InfoSection>

      {/* Strategy */}
      {(strategy || updateStrategy) && (
        <InfoSection title="Strategy">
          <div className="space-y-2">
            <InfoRow label="Type" value={strategy?.type || updateStrategy?.type || '-'} />
            {strategy?.rollingUpdate && (
              <>
                <InfoRow label="Max Unavailable" value={String(strategy.rollingUpdate.maxUnavailable ?? '-')} />
                <InfoRow label="Max Surge" value={String(strategy.rollingUpdate.maxSurge ?? '-')} />
              </>
            )}
          </div>
        </InfoSection>
      )}

      {/* Replicas */}
      {!isJob && !isCronJob && (
        <InfoSection title="Replicas">
          <InfoGrid>
            <InfoRow label="Desired" value={String(spec.replicas ?? '-')} />
            <InfoRow label="Ready" value={String((status.readyReplicas as number) ?? 0)} />
            <InfoRow label="Up to date" value={String((status.updatedReplicas as number) ?? 0)} />
            <InfoRow label="Available" value={String((status.availableReplicas as number) ?? 0)} />
          </InfoGrid>
        </InfoSection>
      )}

      {/* Job Specific */}
      {isJob && (
        <InfoSection title="Job Info">
          <div className="space-y-2">
            <InfoRow label="Completions" value={String(spec.completions ?? '-')} />
            <InfoRow label="Parallelism" value={String(spec.parallelism ?? '-')} />
            <InfoRow label="Active" value={String((status.active as number) ?? 0)} />
            <InfoRow label="Succeeded" value={String((status.succeeded as number) ?? 0)} />
            <InfoRow label="Failed" value={String((status.failed as number) ?? 0)} />
            {status.startTime != null && <InfoRow label="Start Time" value={fmtTs(String(status.startTime))} />}
            {status.completionTime != null && <InfoRow label="Completion Time" value={fmtTs(String(status.completionTime))} />}
          </div>
        </InfoSection>
      )}

      {/* CronJob Specific */}
      {isCronJob && (
        <InfoSection title="CronJob Info">
          <div className="space-y-2">
            <InfoRow label="Schedule" value={String(spec.schedule ?? '-')} />
            <InfoRow label="Suspend" value={spec.suspend ? 'Yes' : 'No'} />
            <InfoRow label="Concurrency Policy" value={String(spec.concurrencyPolicy ?? '-')} />
            {spec.startingDeadlineSeconds != null && <InfoRow label="Starting Deadline" value={`${String(spec.startingDeadlineSeconds)}s`} />}
            {status.lastScheduleTime != null && <InfoRow label="Last Schedule" value={fmtTs(String(status.lastScheduleTime))} />}
            {status.lastSuccessfulTime != null && <InfoRow label="Last Successful" value={fmtTs(String(status.lastSuccessfulTime))} />}
          </div>
        </InfoSection>
      )}

      {/* Selector */}
      {selector && Object.keys(selector).length > 0 && (
        <InfoSection title="Selector">
          <KeyValueTags data={selector} />
        </InfoSection>
      )}

      {/* Node Selector */}
      {nodeSelector && Object.keys(nodeSelector).length > 0 && (
        <InfoSection title="Node Selector">
          <KeyValueTags data={nodeSelector} />
        </InfoSection>
      )}

      {/* Containers */}
      {(containers.length > 0 || cronContainers.length > 0) && (
        <InfoSection title="Container Spec">
          <div className="space-y-3">
            {(isCronJob ? cronContainers : containers).map((c: any, i: number) => (
              <div key={i} className="rounded border border-slate-800 p-3 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-white">{c.name}</span>
                </div>
                <div className="text-xs text-slate-400 space-y-0.5">
                  <div>Image: <span className="text-slate-300 font-mono">{c.image}</span></div>
                  {c.command && <div>Command: <span className="text-slate-300 font-mono">{Array.isArray(c.command) ? c.command.join(' ') : c.command}</span></div>}
                  {c.ports && Array.isArray(c.ports) && c.ports.length > 0 && (
                    <div>Ports: {c.ports.map((p: any) => `${p.containerPort}/${p.protocol || 'TCP'}`).join(', ')}</div>
                  )}
                  {c.resources && (
                    <div className="mt-1">
                      {c.resources.requests && <div>Requests: {Object.entries(c.resources.requests).map(([k, v]) => `${k}=${v}`).join(', ')}</div>}
                      {c.resources.limits && <div>Limits: {Object.entries(c.resources.limits).map(([k, v]) => `${k}=${v}`).join(', ')}</div>}
                    </div>
                  )}
                  {c.env && Array.isArray(c.env) && c.env.length > 0 && (
                    <div>Env: {c.env.length} variable{c.env.length > 1 ? 's' : ''}</div>
                  )}
                  {c.volumeMounts && Array.isArray(c.volumeMounts) && c.volumeMounts.length > 0 && (
                    <div>Mounts: {c.volumeMounts.map((m: any) => `${m.name}→${m.mountPath}`).join(', ')}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </InfoSection>
      )}

      {/* Tolerations (DaemonSet) */}
      {kind === 'DaemonSet' && Array.isArray(podTemplate?.tolerations) && (podTemplate.tolerations as any[]).length > 0 && (
        <InfoSection title="Tolerations">
          <div className="space-y-1 text-xs">
            {(podTemplate.tolerations as any[]).map((tol: any, i: number) => (
              <div key={i} className="text-slate-200">
                {tol.key || '*'} {tol.operator || 'Equal'} {tol.value || ''} {tol.effect || ''} {tol.tolerationSeconds ? `(${tol.tolerationSeconds}s)` : ''}
              </div>
            ))}
          </div>
        </InfoSection>
      )}

      {/* Conditions */}
      {conditions.length > 0 && (
        <InfoSection title="Conditions">
          <ConditionsTable conditions={conditions} />
        </InfoSection>
      )}

      {/* Labels & Annotations */}
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
    </>
  )
}
