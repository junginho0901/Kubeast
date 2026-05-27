import { InfoSection, InfoRow, KeyValueTags, fmtRel, fmtTs } from '../DetailCommon'

export default function ConfigMapDetail({ name, namespace, rawJson }: { name: string; namespace?: string; rawJson?: Record<string, unknown> }) {
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
