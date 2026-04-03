import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { JSONPath } from 'jsonpath-plus'
import { api } from '@/services/api'
import {
  InfoSection,
  InfoRow,
  KeyValueTags,
  ConditionsTable,
  EventsTable,
  fmtRel,
  fmtTs,
} from './DetailCommon'

interface Props {
  name: string
  namespace?: string
  rawJson?: Record<string, unknown>
}

/** Collapsible JSON block for large objects */
function CollapsibleJson({ label, data }: { label: string; data: unknown }) {
  const [open, setOpen] = useState(false)
  const json = JSON.stringify(data, null, 2)
  const lineCount = json.split('\n').length
  const preview = lineCount > 3
    ? json.split('\n').slice(0, 3).join('\n') + '\n  ...'
    : json

  return (
    <div className="rounded border border-slate-800 bg-slate-950/60">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs hover:bg-slate-800/40 transition-colors"
      >
        <span className="text-slate-400 font-medium">{label} <span className="text-slate-600 ml-1">({typeof data === 'object' && data ? Object.keys(data as object).length : 0} keys)</span></span>
        <span className="text-slate-500 text-[11px]">{open ? '▼ collapse' : '▶ expand'}</span>
      </button>
      <div className="px-3 pb-2">
        <pre className="text-[11px] font-mono text-slate-300 whitespace-pre-wrap break-all max-h-[400px] overflow-y-auto">
          {open ? json : preview}
        </pre>
      </div>
    </div>
  )
}

function renderValue(value: unknown, depth = 0): React.ReactNode {
  if (value === null || value === undefined) return <span className="text-slate-500">-</span>
  if (typeof value === 'boolean') return <span className="font-mono text-[11px]">{value.toString()}</span>
  if (typeof value === 'number') return <span className="font-mono text-[11px]">{value}</span>
  if (typeof value === 'string') {
    if (value.length > 200) {
      return <span className="font-mono text-[11px] break-all whitespace-pre-wrap">{value}</span>
    }
    return <span className="font-mono text-[11px] break-words">{value}</span>
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-slate-500">[]</span>
    if (value.every(v => typeof v === 'string' || typeof v === 'number')) {
      return (
        <div className="inline-flex flex-wrap gap-1">
          {value.map((v, i) => (
            <span key={i} className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-100 font-mono">
              {String(v)}
            </span>
          ))}
        </div>
      )
    }
    // Large array → collapsible JSON
    if (value.length > 5) {
      return <CollapsibleJson label={`Array[${value.length}]`} data={value} />
    }
    return (
      <div className="space-y-1.5 mt-1">
        {value.map((item, i) => (
          <div key={i} className="rounded border border-slate-800 bg-slate-900/40 p-2">
            {renderValue(item, depth + 1)}
          </div>
        ))}
      </div>
    )
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return <span className="text-slate-500">{'{}'}</span>

    // Large objects or nested depth → full-width collapsible JSON block
    if (entries.length > 6 || depth >= 2) {
      return <CollapsibleJson label={`Object`} data={value} />
    }

    // Small objects at shallow depth → inline key-value rows (full-width, no nested grid)
    return (
      <div className="space-y-1 mt-1">
        {entries.map(([k, v]) => (
          <div key={k} className="text-xs">
            <span className="text-slate-500 mr-2">{k}:</span>
            <span className="text-slate-200 font-mono">{renderValue(v, depth + 1)}</span>
          </div>
        ))}
      </div>
    )
  }

  return <span className="font-mono text-[11px]">{String(value)}</span>
}

function getValueWithJSONPath(json: object, jsonPath: string): string {
  try {
    const result = JSONPath({ path: '$' + jsonPath, json, wrap: false })
    if (result === undefined || result === null) return ''
    return String(result)
  } catch {
    return ''
  }
}

function formatDateValue(value: string): string {
  try {
    const d = new Date(value)
    if (isNaN(d.getTime())) return value
    return `${fmtTs(value)} (${fmtRel(value)})`
  } catch {
    return value
  }
}

export default function CustomResourceInstanceInfo({ name, namespace, rawJson }: Props) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string) => t(key, { defaultValue: fallback })

  const group = (rawJson?.group as string) || ''
  const version = (rawJson?.version as string) || ''
  const crdName = (rawJson?.crd_name as string) || ''
  const plural = crdName ? crdName.split('.')[0] : ''

  const { data: describe, isLoading } = useQuery({
    queryKey: ['cr-instance-describe', group, version, plural, namespace || '-', name],
    queryFn: () => api.describeCustomResourceInstance(group, version, plural, namespace || '-', name),
    enabled: !!name && !!group && !!version && !!plural,
    retry: false,
  })

  // Fetch CRD to get additionalPrinterColumns
  const { data: crdDescribe } = useQuery({
    queryKey: ['crd-describe', crdName],
    queryFn: () => api.describeCRD(crdName),
    enabled: !!crdName,
    retry: false,
  })

  // Extract printer columns from the CRD's storage version
  const printerColumns = useMemo(() => {
    if (!crdDescribe?.versions) return []
    const versions = Array.isArray(crdDescribe.versions) ? crdDescribe.versions : []
    const storageVer = versions.find((v: any) => v.storage) || versions[0]
    if (!storageVer?.additionalPrinterColumns) return []
    return (storageVer.additionalPrinterColumns as any[]).filter(
      (col: any) => col.jsonPath !== '.metadata.creationTimestamp',
    )
  }, [crdDescribe?.versions])

  // Build the full object JSON for JSONPath evaluation
  const fullJson = useMemo(() => {
    if (!describe) return null
    // Reconstruct a k8s-like object for JSONPath
    return {
      metadata: {
        name: describe.name,
        namespace: describe.namespace,
        uid: describe.uid,
        creationTimestamp: describe.created_at,
        labels: describe.labels,
        annotations: describe.annotations,
      },
      spec: describe.spec || {},
      status: describe.status || {},
    }
  }, [describe])

  const labels = (describe?.labels as Record<string, string> | undefined) ?? {}
  const annotations = (describe?.annotations as Record<string, string> | undefined) ?? {}
  const createdAt = describe?.created_at as string | undefined
  const spec = describe?.spec as Record<string, unknown> | undefined
  const status = describe?.status as Record<string, unknown> | undefined
  const ownerRefs = Array.isArray(describe?.owner_references) ? describe.owner_references : []
  const finalizers = Array.isArray(describe?.finalizers) ? describe.finalizers : []
  const conditions = Array.isArray(status?.conditions) ? status.conditions : []
  const events = Array.isArray(describe?.events) ? describe.events : []

  if (isLoading) return <p className="text-slate-400">{tr('common.loading', 'Loading...')}</p>

  return (
    <div className="space-y-4">
      <InfoSection title={tr('crInstanceInfo.basicInfo', 'Basic Info')}>
        <div className="space-y-2">
          <InfoRow label="Kind" value={describe?.kind || rawJson?.kind as string || '-'} />
          <InfoRow label="Name" value={name} />
          {namespace && <InfoRow label="Namespace" value={namespace} />}
          <InfoRow label="API Version" value={describe?.api_version || `${group}/${version}`} />
          <InfoRow label="CRD" value={crdName || '-'} />
          <InfoRow label="Created" value={createdAt ? `${fmtTs(createdAt)} (${fmtRel(createdAt)})` : '-'} />
          {describe?.uid && <InfoRow label="UID" value={<span className="font-mono text-[11px] break-all">{describe.uid}</span>} />}
          {describe?.resource_version && <InfoRow label="Resource Version" value={<span className="font-mono text-[11px]">{describe.resource_version}</span>} />}
        </div>
      </InfoSection>

      {/* Additional Printer Columns (from CRD) */}
      {printerColumns.length > 0 && fullJson && (
        <InfoSection title={tr('crInstanceInfo.printerColumns', 'Additional Info')}>
          <div className="space-y-2">
            {printerColumns.map((col: any) => {
              const raw = getValueWithJSONPath(fullJson, col.jsonPath)
              const displayValue = col.type === 'date' && raw ? formatDateValue(raw) : (raw || '-')
              return (
                <InfoRow
                  key={col.name}
                  label={col.name}
                  value={<span className="font-mono text-[11px]">{displayValue}</span>}
                />
              )
            })}
          </div>
        </InfoSection>
      )}

      {/* Spec */}
      {spec && Object.keys(spec).length > 0 && (
        <InfoSection title={tr('crInstanceInfo.spec', 'Spec')}>
          <div className="space-y-2">
            {Object.entries(spec).map(([key, value]) => (
              <InfoRow key={key} label={key} value={renderValue(value)} />
            ))}
          </div>
        </InfoSection>
      )}

      {/* Status */}
      {status && Object.keys(status).length > 0 && (
        <InfoSection title={tr('crInstanceInfo.status', 'Status')}>
          <div className="space-y-2">
            {Object.entries(status).filter(([k]) => k !== 'conditions').map(([key, value]) => (
              <InfoRow key={key} label={key} value={renderValue(value)} />
            ))}
          </div>
        </InfoSection>
      )}

      {/* Conditions */}
      {conditions.length > 0 && (
        <InfoSection title={tr('crInstanceInfo.conditions', 'Conditions')}>
          <ConditionsTable conditions={conditions} />
        </InfoSection>
      )}

      {/* Owner References */}
      {ownerRefs.length > 0 && (
        <InfoSection title={tr('crInstanceInfo.ownerReferences', 'Owner References')}>
          <div className="space-y-2">
            {ownerRefs.map((ref: any, idx: number) => (
              <div key={idx} className="rounded border border-slate-800 bg-slate-900/40 p-3 text-xs text-slate-300 space-y-1">
                <div><span className="text-slate-500 mr-2">Kind:</span>{ref.kind}</div>
                <div><span className="text-slate-500 mr-2">Name:</span>{ref.name}</div>
              </div>
            ))}
          </div>
        </InfoSection>
      )}

      {/* Finalizers */}
      {finalizers.length > 0 && (
        <InfoSection title={tr('crInstanceInfo.finalizers', 'Finalizers')}>
          <div className="inline-flex flex-wrap gap-1">
            {finalizers.map((f: string) => (
              <span key={f} className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-100 font-mono break-all">{f}</span>
            ))}
          </div>
        </InfoSection>
      )}

      {/* Events */}
      {events.length > 0 && (
        <InfoSection title={tr('crInstanceInfo.events', 'Events')}>
          <EventsTable events={events} />
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
    </div>
  )
}
