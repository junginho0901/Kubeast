import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { ConditionsTable, EventsTable, InfoSection, InfoRow, KeyValueTags, StatusBadge, fmtRel, fmtTs } from './DetailCommon'

interface Props {
  name: string
  namespace?: string
  kind: string
  rawJson?: Record<string, unknown>
}

export default function ConfigStorageInfo({ name, namespace, kind, rawJson }: Props) {
  if (kind === 'ConfigMap') return <ConfigMapDetail name={name} namespace={namespace} rawJson={rawJson} />
  if (kind === 'Secret') return <SecretDetail name={name} namespace={namespace} rawJson={rawJson} />
  if (kind === 'PersistentVolume') return <PVDetail name={name} rawJson={rawJson} />
  if (kind === 'PersistentVolumeClaim') return <PVCDetail name={name} namespace={namespace} rawJson={rawJson} />
  if (kind === 'StorageClass') return <StorageClassDetail name={name} rawJson={rawJson} />
  if (kind === 'HorizontalPodAutoscaler') return <HPADetail name={name} namespace={namespace} rawJson={rawJson} />
  return null
}

function ConfigMapDetail({ name, namespace, rawJson }: { name: string; namespace?: string; rawJson?: Record<string, unknown> }) {
  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const data = (rawJson?.data ?? {}) as Record<string, string>
  const labels = (meta.labels ?? {}) as Record<string, string>

  return (
    <>
      <InfoSection title="ConfigMap Info">
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          {namespace && <InfoRow label="Namespace" value={namespace} />}
          <InfoRow label="Data Keys" value={String(Object.keys(data).length)} />
          <InfoRow label="Created" value={meta.creationTimestamp ? `${fmtTs(meta.creationTimestamp as string)} (${fmtRel(meta.creationTimestamp as string)})` : '-'} />
        </div>
      </InfoSection>

      {Object.keys(data).length > 0 && (
        <InfoSection title="Data">
          <div className="space-y-3">
            {Object.entries(data).map(([key, value]) => (
              <div key={key} className="rounded border border-slate-800 p-3">
                <p className="text-xs font-medium text-white mb-1">{key}</p>
                <pre className="text-[11px] text-slate-300 bg-slate-950 rounded p-2 max-h-[200px] overflow-auto whitespace-pre-wrap break-all">
                  {String(value).slice(0, 2000)}
                  {String(value).length > 2000 && '\n... (truncated)'}
                </pre>
              </div>
            ))}
          </div>
        </InfoSection>
      )}

      {Object.keys(labels).length > 0 && <InfoSection title="Labels"><KeyValueTags data={labels} /></InfoSection>}
    </>
  )
}

function SecretDetail({ name, namespace, rawJson }: { name: string; namespace?: string; rawJson?: Record<string, unknown> }) {
  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const data = (rawJson?.data ?? {}) as Record<string, string>
  const labels = (meta.labels ?? {}) as Record<string, string>
  const secretType = rawJson?.type as string || 'Opaque'

  return (
    <>
      <InfoSection title="Secret Info">
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          {namespace && <InfoRow label="Namespace" value={namespace} />}
          <InfoRow label="Type" value={secretType} />
          <InfoRow label="Data Keys" value={String(Object.keys(data).length)} />
          <InfoRow label="Created" value={meta.creationTimestamp ? `${fmtTs(meta.creationTimestamp as string)} (${fmtRel(meta.creationTimestamp as string)})` : '-'} />
        </div>
      </InfoSection>

      {Object.keys(data).length > 0 && (
        <InfoSection title="Data">
          <div className="space-y-2">
            {Object.entries(data).map(([key, value]) => (
              <div key={key} className="flex items-center gap-2 text-xs">
                <span className="font-medium text-white min-w-[140px]">{key}</span>
                <span className="text-slate-400 font-mono">{value ? `${value.length} bytes (base64)` : '(empty)'}</span>
              </div>
            ))}
          </div>
        </InfoSection>
      )}

      {Object.keys(labels).length > 0 && <InfoSection title="Labels"><KeyValueTags data={labels} /></InfoSection>}
    </>
  )
}

function PVDetail({ name, rawJson }: { name: string; rawJson?: Record<string, unknown> }) {
  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const spec = (rawJson?.spec ?? {}) as Record<string, unknown>
  const status = (rawJson?.status ?? {}) as Record<string, unknown>
  const labels = (meta.labels ?? {}) as Record<string, string>
  const capacity = (spec.capacity as Record<string, string>) ?? {}
  const accessModes = (spec.accessModes ?? []) as string[]

  return (
    <>
      <InfoSection title="PersistentVolume Info">
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          <InfoRow label="Status" value={<StatusBadge status={String(status.phase ?? '-')} />} />
          <InfoRow label="Capacity" value={capacity.storage || '-'} />
          <InfoRow label="Access Modes" value={accessModes.join(', ') || '-'} />
          <InfoRow label="Reclaim Policy" value={String(spec.persistentVolumeReclaimPolicy ?? '-')} />
          <InfoRow label="Storage Class" value={String(spec.storageClassName ?? '-')} />
          <InfoRow label="Volume Mode" value={String(spec.volumeMode ?? 'Filesystem')} />
          {spec.claimRef != null && <InfoRow label="Claim" value={`${(spec.claimRef as Record<string, unknown>).namespace ?? ''}/${(spec.claimRef as Record<string, unknown>).name ?? ''}`} />}
          <InfoRow label="Created" value={meta.creationTimestamp ? `${fmtTs(meta.creationTimestamp as string)} (${fmtRel(meta.creationTimestamp as string)})` : '-'} />
        </div>
      </InfoSection>
      {Object.keys(labels).length > 0 && <InfoSection title="Labels"><KeyValueTags data={labels} /></InfoSection>}
    </>
  )
}

function PVCDetail({ name, namespace, rawJson }: { name: string; namespace?: string; rawJson?: Record<string, unknown> }) {
  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const spec = (rawJson?.spec ?? {}) as Record<string, unknown>
  const status = (rawJson?.status ?? {}) as Record<string, unknown>
  const labels = (meta.labels ?? {}) as Record<string, string>
  const accessModes = (spec.accessModes ?? []) as string[]
  const capacity = (status.capacity as Record<string, string>) ?? {}
  const requested = ((spec.resources as any)?.requests as Record<string, string>) ?? {}

  return (
    <>
      <InfoSection title="PersistentVolumeClaim Info">
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          {namespace && <InfoRow label="Namespace" value={namespace} />}
          <InfoRow label="Status" value={<StatusBadge status={String(status.phase ?? '-')} />} />
          <InfoRow label="Capacity" value={capacity.storage || '-'} />
          <InfoRow label="Requested" value={requested.storage || '-'} />
          <InfoRow label="Access Modes" value={accessModes.join(', ') || '-'} />
          <InfoRow label="Storage Class" value={String(spec.storageClassName ?? '-')} />
          <InfoRow label="Volume Mode" value={String(spec.volumeMode ?? 'Filesystem')} />
          <InfoRow label="Volume Name" value={String(spec.volumeName ?? '-')} />
          <InfoRow label="Created" value={meta.creationTimestamp ? `${fmtTs(meta.creationTimestamp as string)} (${fmtRel(meta.creationTimestamp as string)})` : '-'} />
        </div>
      </InfoSection>
      {Object.keys(labels).length > 0 && <InfoSection title="Labels"><KeyValueTags data={labels} /></InfoSection>}
    </>
  )
}

function StorageClassDetail({ name, rawJson }: { name: string; rawJson?: Record<string, unknown> }) {
  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const labels = (meta.labels ?? {}) as Record<string, string>
  const parameters = (rawJson?.parameters ?? {}) as Record<string, string>

  return (
    <>
      <InfoSection title="StorageClass Info">
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          <InfoRow label="Provisioner" value={String(rawJson?.provisioner ?? '-')} />
          <InfoRow label="Reclaim Policy" value={String(rawJson?.reclaimPolicy ?? '-')} />
          <InfoRow label="Volume Binding Mode" value={String(rawJson?.volumeBindingMode ?? '-')} />
          <InfoRow label="Allow Expansion" value={rawJson?.allowVolumeExpansion ? 'Yes' : 'No'} />
          <InfoRow label="Created" value={meta.creationTimestamp ? `${fmtTs(meta.creationTimestamp as string)} (${fmtRel(meta.creationTimestamp as string)})` : '-'} />
        </div>
      </InfoSection>

      {Object.keys(parameters).length > 0 && (
        <InfoSection title="Parameters">
          <KeyValueTags data={parameters} />
        </InfoSection>
      )}

      {Object.keys(labels).length > 0 && <InfoSection title="Labels"><KeyValueTags data={labels} /></InfoSection>}
    </>
  )
}

function HPADetail({ name, namespace, rawJson }: { name: string; namespace?: string; rawJson?: Record<string, unknown> }) {
  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const spec = (rawJson?.spec ?? {}) as Record<string, unknown>
  const status = (rawJson?.status ?? {}) as Record<string, unknown>
  const labels = (meta.labels ?? {}) as Record<string, string>
  const scaleRef = spec.scaleTargetRef as Record<string, string> | undefined
  const metrics = (spec.metrics ?? []) as any[]
  const currentMetrics = (status.currentMetrics ?? []) as any[]
  const conditions = (status.conditions ?? []) as any[]

  return (
    <>
      <InfoSection title="HPA Info">
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          {namespace && <InfoRow label="Namespace" value={namespace} />}
          {scaleRef && <InfoRow label="Target" value={`${scaleRef.kind}/${scaleRef.name}`} />}
          <InfoRow label="Min Replicas" value={String(spec.minReplicas ?? 1)} />
          <InfoRow label="Max Replicas" value={String(spec.maxReplicas ?? '-')} />
          <InfoRow label="Current Replicas" value={String(status.currentReplicas ?? '-')} />
          <InfoRow label="Desired Replicas" value={String(status.desiredReplicas ?? '-')} />
          <InfoRow label="Created" value={meta.creationTimestamp ? `${fmtTs(meta.creationTimestamp as string)} (${fmtRel(meta.creationTimestamp as string)})` : '-'} />
        </div>
      </InfoSection>

      {metrics.length > 0 && (
        <InfoSection title="Metrics">
          <div className="space-y-2 text-xs">
            {metrics.map((m: any, i: number) => {
              const current = currentMetrics[i]
              return (
                <div key={i} className="rounded border border-slate-800 p-2 text-slate-200">
                  <div>Type: {m.type}</div>
                  {m.resource && <div>Resource: {m.resource.name} target={m.resource.target?.averageUtilization ?? m.resource.target?.averageValue ?? '-'}
                    {current?.resource && <> current={current.resource.current?.averageUtilization ?? current.resource.current?.averageValue ?? '-'}</>}</div>}
                  {m.pods && <div>Pods: {m.pods.metric?.name} target={m.pods.target?.averageValue ?? '-'}</div>}
                  {m.object && <div>Object: {m.object.metric?.name} target={m.object.target?.value ?? '-'}</div>}
                </div>
              )
            })}
          </div>
        </InfoSection>
      )}

      {conditions.length > 0 && (
        <InfoSection title="Conditions">
          <div className="space-y-1 text-xs">
            {conditions.map((c: any, i: number) => (
              <div key={i} className="flex items-center gap-2 text-slate-200">
                <StatusBadge status={c.status} />
                <span className="text-white">{c.type}</span>
                {c.reason && <span className="text-slate-400">({c.reason})</span>}
              </div>
            ))}
          </div>
        </InfoSection>
      )}

      {Object.keys(labels).length > 0 && <InfoSection title="Labels"><KeyValueTags data={labels} /></InfoSection>}
    </>
  )
}
