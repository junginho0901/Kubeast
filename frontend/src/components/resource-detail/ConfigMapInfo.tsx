import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/services/api'
import {
  InfoSection,
  InfoRow,
  KeyValueTags,
  EventsTable,
  fmtRel,
  fmtTs,
} from './DetailCommon'

interface Props {
  name: string
  namespace: string
  rawJson?: Record<string, unknown>
}

export default function ConfigMapInfo({ name, namespace, rawJson }: Props) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string) => t(key, { defaultValue: fallback })
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())

  const { data: describe, isLoading } = useQuery({
    queryKey: ['configmap-describe', namespace, name],
    queryFn: () => api.describeConfigMap(namespace, name),
    enabled: !!namespace && !!name,
    retry: false,
  })

  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const labels = (describe?.labels as Record<string, string> | undefined) ?? (meta.labels as Record<string, string> | undefined) ?? {}
  const annotations = (describe?.annotations as Record<string, string> | undefined) ?? (meta.annotations as Record<string, string> | undefined) ?? {}
  const createdAt = (describe?.created_at as string | undefined) ?? (meta.creationTimestamp as string | undefined)
  const dataEntries = (describe?.data as Record<string, string> | undefined) ?? {}
  const dataKeys = Array.isArray(describe?.data_keys) ? describe.data_keys : Object.keys(dataEntries)
  const binaryKeys = Array.isArray(describe?.binary_keys) ? describe.binary_keys : []
  const events = Array.isArray(describe?.events) ? describe.events : []

  const [dataSearch, setDataSearch] = useState('')
  const [dataPage, setDataPage] = useState(1)
  const DATA_PER_PAGE = 10

  const filteredDataKeys = useMemo(() => {
    if (!dataSearch.trim()) return dataKeys as string[]
    const q = dataSearch.toLowerCase()
    return (dataKeys as string[]).filter((k: string) => k.toLowerCase().includes(q))
  }, [dataKeys, dataSearch])

  const pagedDataKeys = useMemo(() => {
    const start = (dataPage - 1) * DATA_PER_PAGE
    return filteredDataKeys.slice(start, start + DATA_PER_PAGE)
  }, [filteredDataKeys, dataPage])

  const dataTotalPages = Math.max(1, Math.ceil(filteredDataKeys.length / DATA_PER_PAGE))

  const toggleKey = (key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  if (isLoading) return <p className="text-slate-400">{tr('common.loading', 'Loading...')}</p>

  return (
    <div className="space-y-4">
      <InfoSection title="Basic Info">
        <div className="space-y-2">
          <InfoRow label="Kind" value="ConfigMap" />
          <InfoRow label="Name" value={name} />
          <InfoRow label="Namespace" value={namespace} />
          <InfoRow label="Created" value={createdAt ? `${fmtTs(createdAt)} (${fmtRel(createdAt)})` : '-'} />
          {describe?.uid && <InfoRow label="UID" value={<span className="font-mono text-[11px] break-all">{describe.uid}</span>} />}
          {describe?.resource_version && <InfoRow label="Resource Version" value={<span className="font-mono text-[11px]">{describe.resource_version}</span>} />}
          <InfoRow label="Data Keys" value={String(describe?.data_count ?? dataKeys.length)} />
          {binaryKeys.length > 0 && <InfoRow label="Binary Keys" value={String(describe?.binary_count ?? binaryKeys.length)} />}
        </div>
      </InfoSection>

      <InfoSection title={`Data (${filteredDataKeys.length}${dataSearch ? ` / ${dataKeys.length}` : ''})`}>
        {dataKeys.length > DATA_PER_PAGE && (
          <div className="mb-2">
            <input
              type="text"
              placeholder="Search keys..."
              value={dataSearch}
              onChange={(e) => { setDataSearch(e.target.value); setDataPage(1) }}
              className="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
            />
          </div>
        )}

        {pagedDataKeys.length > 0 ? (
          <div className="space-y-1.5">
            {pagedDataKeys.map((key: string) => {
              const value = dataEntries[key]
              const isExpanded = expandedKeys.has(key)
              const isLong = value && value.length > 200

              return (
                <div key={key} className="rounded border border-slate-800 bg-slate-900/40">
                  <button
                    type="button"
                    onClick={() => toggleKey(key)}
                    className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-slate-800/40 transition-colors"
                  >
                    <span className="font-mono text-xs text-cyan-300 break-all">{key}</span>
                    <span className="text-[10px] text-slate-500 ml-2 flex-shrink-0">
                      {value ? `${value.length} chars` : 'empty'}
                    </span>
                  </button>
                  {isExpanded && (
                    <div className="px-3 pb-2 border-t border-slate-800">
                      <pre className={`text-[11px] text-slate-300 whitespace-pre-wrap break-words mt-1.5 ${isLong ? 'max-h-[300px] overflow-y-auto' : ''}`}>
                        {value || <span className="text-slate-600 italic">{'(empty)'}</span>}
                      </pre>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          <p className="text-xs text-slate-500">{dataSearch ? 'No matching keys.' : 'No data entries.'}</p>
        )}

        {filteredDataKeys.length > DATA_PER_PAGE && (
          <div className="flex items-center justify-between mt-2">
            <span className="text-[10px] text-slate-500">{dataPage} / {dataTotalPages}</span>
            <div className="flex gap-1">
              <button type="button" onClick={() => setDataPage((p) => Math.max(1, p - 1))} disabled={dataPage <= 1} className="px-2 py-0.5 text-[10px] rounded border border-slate-700 text-slate-400 disabled:opacity-40">Prev</button>
              <button type="button" onClick={() => setDataPage((p) => Math.min(dataTotalPages, p + 1))} disabled={dataPage >= dataTotalPages} className="px-2 py-0.5 text-[10px] rounded border border-slate-700 text-slate-400 disabled:opacity-40">Next</button>
            </div>
          </div>
        )}
      </InfoSection>

      {binaryKeys.length > 0 && (
        <InfoSection title={`Binary Data Keys (${binaryKeys.length})`}>
          <div className="flex flex-wrap gap-1">
            {binaryKeys.map((key: string) => (
              <span key={key} className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-300 font-mono">
                {key}
              </span>
            ))}
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

      {events.length > 0 && (
        <InfoSection title="Events">
          <EventsTable events={events} />
        </InfoSection>
      )}
    </div>
  )
}
