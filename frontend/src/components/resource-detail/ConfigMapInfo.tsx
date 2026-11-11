import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/services/api'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { podTableStatus } from '@/pages/workloads/pods/podHelpers'
import { InfoSection, InfoRow, KeyValueTags, EventsSection, StatusBadge, Th, Tx } from './DetailCommon'
import { fmtRel, fmtTs } from './detailFormat'
import { useDetailLabel } from './useDetailLabel'
import { useNamespacePodTable } from './useNamespacePodTable'
import { useResourceDetailOverlay } from '@/hooks/useResourceDetailOverlay'
import { DescribeFailure, DescribeStale } from './DescribeFailure'

interface Props {
  name: string
  namespace: string
  rawJson?: Record<string, unknown>
}

export default function ConfigMapInfo({ name, namespace, rawJson }: Props) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string) => t(key, { defaultValue: fallback })
  const dl = useDetailLabel()
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())
  const { open: openDetail } = useResourceDetail()

  const { data: describe, isLoading, error: describeError, dataUpdatedAt } = useQuery({
    queryKey: ['configmap-describe', namespace, name],
    queryFn: () => api.describeConfigMap(namespace, name),
    enabled: !!namespace && !!name,
    retry: false,
  })

  useResourceDetailOverlay({ kind: 'ConfigMap', name, namespace, describe })

  const podsEnabled = !!namespace && !!name
  const usingPods = useNamespacePodTable({
    enabled: podsEnabled,
    namespace,
    filter: { config_map: name },
    queryKey: ['cm-used-by-pods', namespace, name],
    keeps: (p) => (Array.isArray(p?.config_map_refs) ? p.config_map_refs : []).includes(name),
  })

  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const labels = (describe?.labels as Record<string, string> | undefined) ?? (meta.labels as Record<string, string> | undefined) ?? {}
  const annotations = (describe?.annotations as Record<string, string> | undefined) ?? (meta.annotations as Record<string, string> | undefined) ?? {}
  const createdAt = (describe?.created_at as string | undefined) ?? (meta.creationTimestamp as string | undefined)
  const dataEntries = (describe?.data as Record<string, string> | undefined) ?? {}
  const dataKeys = Array.isArray(describe?.data_keys) ? describe.data_keys : Object.keys(dataEntries)
  const binaryKeys = Array.isArray(describe?.binary_keys) ? describe.binary_keys : []

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
  // nothing below was read: the bindings, keys and versions come from the describe answer only
  if (describeError && !describe) return <DescribeFailure error={describeError} className="py-4" />

  return (
    <div className="space-y-4">
      <DescribeStale error={describeError} readAt={dataUpdatedAt} />
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
          {(describe as any)?.immutable !== undefined && <InfoRow label="Immutable" value={(describe as any).immutable ? 'Yes' : 'No'} />}
        </div>
      </InfoSection>

      <InfoSection title="Data ({{n}}{{total}})" titleValues={{ n: filteredDataKeys.length, total: dataSearch ? ` / ${dataKeys.length}` : '' }}>
        {dataKeys.length > DATA_PER_PAGE && (
          <div className="mb-2">
            <input
              type="text"
              placeholder={dl('Search keys...')}
              value={dataSearch}
              onChange={(e) => { setDataSearch(e.target.value); setDataPage(1) }}
              className="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-sm text-xs text-ink placeholder-slate-500 focus:outline-hidden focus:ring-1 focus:ring-primary-500"
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
                <div key={key} className="rounded-sm border border-slate-800 bg-slate-900/40">
                  <button
                    type="button"
                    onClick={() => toggleKey(key)}
                    className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-slate-800/40 transition-colors"
                  >
                    <span className="font-mono text-xs text-slate-200 break-all">{key}</span>
                    <span className="text-[10px] text-slate-500 ml-2 shrink-0">
                      {value ? dl('{{n}} chars', { n: value.length }) : dl('empty')}
                    </span>
                  </button>
                  {isExpanded && (
                    <div className="px-3 pb-2 border-t border-slate-800">
                      <pre className={`text-[11px] text-slate-300 whitespace-pre-wrap wrap-break-word mt-1.5 ${isLong ? 'max-h-[300px] overflow-y-auto' : ''}`}>
                        {value || <span className="text-slate-600 italic"><Tx>(empty)</Tx></span>}
                      </pre>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          <p className="text-xs text-slate-500">{dataSearch ? t('common.noSearchResults', { defaultValue: 'No results found.' }) : <Tx>No data entries.</Tx>}</p>
        )}

        {filteredDataKeys.length > DATA_PER_PAGE && (
          <div className="flex items-center justify-between mt-2">
            <span className="text-[10px] text-slate-500">{dataPage} / {dataTotalPages}</span>
            <div className="flex gap-1">
              <button type="button" onClick={() => setDataPage((p) => Math.max(1, p - 1))} disabled={dataPage <= 1} className="px-2 py-0.5 text-[10px] rounded-sm border border-slate-700 text-slate-400 disabled:opacity-40"><Tx>Prev</Tx></button>
              <button type="button" onClick={() => setDataPage((p) => Math.min(dataTotalPages, p + 1))} disabled={dataPage >= dataTotalPages} className="px-2 py-0.5 text-[10px] rounded-sm border border-slate-700 text-slate-400 disabled:opacity-40"><Tx>Next</Tx></button>
            </div>
          </div>
        )}
      </InfoSection>

      {binaryKeys.length > 0 && (
        <InfoSection title="Binary Data Keys ({{n}})" titleValues={{ n: binaryKeys.length }}>
          <div className="flex flex-wrap gap-1">
            {binaryKeys.map((key: string) => (
              <span key={key} className="inline-flex rounded-sm border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-300 font-mono">
                {key}
              </span>
            ))}
          </div>
        </InfoSection>
      )}

      {podsEnabled && (
        <InfoSection title="Used By Pods ({{n}})" titleValues={{ n: usingPods.total }}>
          {usingPods.note}
          {usingPods.loading ? (
            <p className="text-xs text-slate-400"><Tx>Loading...</Tx></p>
          ) : usingPods.total === 0 ? (
            <p className="text-xs text-slate-400"><Tx>No pod in this namespace references this ConfigMap.</Tx></p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-slate-400">
                  <tr>
                    <Th className="text-left py-1">Pod</Th>
                    <Th className="text-left py-1">Status</Th>
                    <Th className="text-left py-1">Ready</Th>
                    <Th className="text-left py-1">Node</Th>
                    <Th className="text-left py-1">Age</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {usingPods.items.map((p) => (
                    <tr
                      key={`${p.namespace}/${p.name}`}
                      className="text-slate-200 hover:bg-slate-800/40 cursor-pointer"
                      onClick={() => openDetail({ kind: 'Pod', name: p.name, namespace: p.namespace })}
                    >
                      <td className="py-1 pr-2 font-mono">{p.name}</td>
                      <td className="py-1 pr-2"><StatusBadge status={podTableStatus(p)} /></td>
                      <td className="py-1 pr-2">{p.ready ?? '-'}</td>
                      <td className="py-1 pr-2 truncate max-w-[160px]">{p.node_name || '-'}</td>
                      <td className="py-1 pr-2 text-slate-400">{fmtRel(p.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {usingPods.nav}
            </div>
          )}
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

      <EventsSection events={describe?.events} error={describe?.events_error} loading={isLoading} />
    </div>
  )
}
