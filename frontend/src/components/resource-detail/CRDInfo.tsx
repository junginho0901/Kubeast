import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/services/api'
import {
  InfoSection,
  InfoRow,
  KeyValueTags,
  ConditionsTable,
  fmtRel,
  fmtTs,
} from './DetailCommon'

interface Props {
  name: string
  rawJson?: Record<string, unknown>
}

function formatAge(createdAt?: string | null): string {
  if (!createdAt) return '-'
  const ms = new Date(createdAt).getTime()
  if (!Number.isFinite(ms)) return '-'
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export default function CRDInfo({ name, rawJson }: Props) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string) => t(key, { defaultValue: fallback })

  const { data: describe, isLoading } = useQuery({
    queryKey: ['crd-describe', name],
    queryFn: () => api.describeCRD(name),
    enabled: !!name,
    retry: false,
  })

  // Fetch CR instances for this CRD
  const group = describe?.group as string || ''
  const plural = describe?.plural as string || ''
  const storageVersion = useMemo(() => {
    const versions = Array.isArray(describe?.versions) ? describe.versions : []
    const sv = versions.find((v: any) => v.storage)
    return sv?.name || versions[0]?.name || ''
  }, [describe?.versions])

  const { data: crInstances } = useQuery({
    queryKey: ['crd-instances', group, storageVersion, plural],
    queryFn: () => api.getCustomResourceInstances(group, storageVersion, plural),
    enabled: !!group && !!storageVersion && !!plural,
    retry: false,
  })

  const [instanceSearch, setInstanceSearch] = useState('')
  const [instancePage, setInstancePage] = useState(1)
  const instancesPerPage = 10

  const filteredInstances = useMemo(() => {
    if (!Array.isArray(crInstances)) return []
    if (!instanceSearch.trim()) return crInstances
    const q = instanceSearch.toLowerCase()
    return crInstances.filter((inst: any) =>
      inst.name?.toLowerCase().includes(q) ||
      inst.namespace?.toLowerCase().includes(q),
    )
  }, [crInstances, instanceSearch])

  const instanceTotalPages = Math.max(1, Math.ceil(filteredInstances.length / instancesPerPage))
  const pagedInstances = useMemo(() => {
    const start = (instancePage - 1) * instancesPerPage
    return filteredInstances.slice(start, start + instancesPerPage)
  }, [filteredInstances, instancePage])

  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const labels = (describe?.labels as Record<string, string> | undefined) ?? (meta.labels as Record<string, string> | undefined) ?? {}
  const annotations = (describe?.annotations as Record<string, string> | undefined) ?? (meta.annotations as Record<string, string> | undefined) ?? {}
  const createdAt = (describe?.created_at as string | undefined) ?? (meta.creationTimestamp as string | undefined)

  const versions = Array.isArray(describe?.versions) ? describe.versions : []
  const conditions = Array.isArray(describe?.conditions) ? describe.conditions : []
  const shortNames = Array.isArray(describe?.short_names) ? describe.short_names : []
  const categories = Array.isArray(describe?.categories) ? describe.categories : []
  const storedVersions = Array.isArray(describe?.stored_versions) ? describe.stored_versions : []
  const subresources = Array.isArray(describe?.subresources) ? describe.subresources as string[] : []

  if (isLoading) return <p className="text-slate-400">{tr('common.loading', 'Loading...')}</p>

  return (
    <div className="space-y-4">
      <InfoSection title={tr('crdInfo.basicInfo', 'Basic Info')}>
        <div className="space-y-2">
          <InfoRow label="Kind" value="CustomResourceDefinition" />
          <InfoRow label="Name" value={name} />
          <InfoRow label={tr('crdInfo.group', 'Group')} value={describe?.group || '-'} />
          <InfoRow label={tr('crdInfo.scope', 'Scope')} value={
            describe?.scope ? (
              <span className={`inline-flex px-2 py-0.5 rounded text-[11px] font-medium ${
                describe.scope === 'Namespaced' ? 'bg-cyan-900/40 text-cyan-300' : 'bg-purple-900/40 text-purple-300'
              }`}>
                {describe.scope}
              </span>
            ) : '-'
          } />
          <InfoRow label={tr('crdInfo.resourceKind', 'Resource Kind')} value={describe?.kind || '-'} />
          <InfoRow label={tr('crdInfo.plural', 'Plural')} value={describe?.plural || '-'} />
          <InfoRow label={tr('crdInfo.singular', 'Singular')} value={describe?.singular || '-'} />
          <InfoRow label={tr('crdInfo.listKind', 'List Kind')} value={describe?.list_kind || '-'} />
          {shortNames.length > 0 && (
            <InfoRow label={tr('crdInfo.shortNames', 'Short Names')} value={
              <div className="inline-flex flex-wrap gap-1">
                {shortNames.map((n: string) => (
                  <span key={n} className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-100 font-mono">{n}</span>
                ))}
              </div>
            } />
          )}
          {categories.length > 0 && (
            <InfoRow label={tr('crdInfo.categories', 'Categories')} value={
              <div className="inline-flex flex-wrap gap-1">
                {categories.map((c: string) => (
                  <span key={c} className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-100 font-mono">{c}</span>
                ))}
              </div>
            } />
          )}
          {subresources.length > 0 && (
            <InfoRow label={tr('crdInfo.subresources', 'Subresources')} value={
              <div className="inline-flex flex-wrap gap-1">
                {subresources.map((s) => (
                  <span key={s} className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-100 font-mono">{s}</span>
                ))}
              </div>
            } />
          )}
          <InfoRow label="Created" value={createdAt ? `${fmtTs(createdAt)} (${fmtRel(createdAt)})` : '-'} />
          {describe?.uid && <InfoRow label="UID" value={<span className="font-mono text-[11px] break-all">{describe.uid}</span>} />}
          {describe?.resource_version && <InfoRow label="Resource Version" value={<span className="font-mono text-[11px]">{describe.resource_version}</span>} />}
        </div>
      </InfoSection>

      {/* Accepted Names */}
      {describe?.accepted_names && (
        <InfoSection title={tr('crdInfo.acceptedNames', 'Accepted Names')}>
          <div className="space-y-2">
            <InfoRow label="Kind" value={describe.accepted_names.kind || '-'} />
            <InfoRow label="Plural" value={describe.accepted_names.plural || '-'} />
            {describe.accepted_names.singular && <InfoRow label="Singular" value={describe.accepted_names.singular} />}
            {describe.accepted_names.listKind && <InfoRow label="List Kind" value={describe.accepted_names.listKind} />}
            {Array.isArray(describe.accepted_names.shortNames) && describe.accepted_names.shortNames.length > 0 && (
              <InfoRow label="Short Names" value={describe.accepted_names.shortNames.join(', ')} />
            )}
            {Array.isArray(describe.accepted_names.categories) && describe.accepted_names.categories.length > 0 && (
              <InfoRow label="Categories" value={describe.accepted_names.categories.join(', ')} />
            )}
          </div>
        </InfoSection>
      )}

      {/* Versions */}
      {versions.length > 0 && (
        <InfoSection title={tr('crdInfo.versions', 'Versions')}>
          <div className="space-y-2">
            {versions.map((ver: any) => (
              <div key={ver.name} className="rounded border border-slate-800 bg-slate-900/40 p-3 space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-white">{ver.name}</span>
                  {ver.storage && (
                    <span className="inline-flex px-2 py-0.5 rounded text-[11px] font-medium bg-green-900/40 text-green-300">Storage</span>
                  )}
                  {ver.served && (
                    <span className="inline-flex px-2 py-0.5 rounded text-[11px] font-medium bg-blue-900/40 text-blue-300">Served</span>
                  )}
                  {!ver.served && (
                    <span className="inline-flex px-2 py-0.5 rounded text-[11px] font-medium bg-slate-800 text-slate-400">Not Served</span>
                  )}
                </div>
                {Array.isArray(ver.additionalPrinterColumns) && ver.additionalPrinterColumns.length > 0 && (
                  <div className="mt-2">
                    <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Additional Printer Columns</p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-slate-500">
                            <th className="text-left py-1 pr-3">Name</th>
                            <th className="text-left py-1 pr-3">Type</th>
                            <th className="text-left py-1">JSON Path</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ver.additionalPrinterColumns.map((col: any, idx: number) => (
                            <tr key={idx} className="text-slate-300">
                              <td className="py-1 pr-3 font-mono">{col.name}</td>
                              <td className="py-1 pr-3">{col.type}</td>
                              <td className="py-1 font-mono text-[11px] break-all">{col.jsonPath}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </InfoSection>
      )}

      {/* Stored Versions */}
      {storedVersions.length > 0 && (
        <InfoSection title={tr('crdInfo.storedVersions', 'Stored Versions')}>
          <div className="inline-flex flex-wrap gap-1">
            {storedVersions.map((v: string) => (
              <span key={v} className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-100 font-mono">{v}</span>
            ))}
          </div>
        </InfoSection>
      )}

      {/* Conditions */}
      {conditions.length > 0 && (
        <InfoSection title={tr('crdInfo.conditions', 'Conditions')}>
          <ConditionsTable conditions={conditions} />
        </InfoSection>
      )}

      {/* CR Instances sub-list */}
      {Array.isArray(crInstances) && (
        <InfoSection title={tr('crdInfo.instances', `Custom Resources (${filteredInstances.length})`)}>
          {crInstances.length > 5 && (
            <div className="mb-2">
              <input
                type="text"
                placeholder={tr('crdInfo.searchInstances', 'Search instances...')}
                value={instanceSearch}
                onChange={(e) => { setInstanceSearch(e.target.value); setInstancePage(1) }}
                className="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
              />
            </div>
          )}
          {filteredInstances.length === 0 ? (
            <p className="text-xs text-slate-500">{tr('crdInfo.noInstances', 'No instances found.')}</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-slate-500">
                      <th className="text-left py-1.5 pr-3">Name</th>
                      <th className="text-left py-1.5 pr-3">Namespace</th>
                      <th className="text-left py-1.5">Age</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {pagedInstances.map((inst: any) => (
                      <tr key={`${inst.namespace || '-'}/${inst.name}`} className="text-slate-300 hover:bg-slate-800/40">
                        <td className="py-1.5 pr-3 font-mono text-white truncate max-w-[200px]">{inst.name}</td>
                        <td className="py-1.5 pr-3">{inst.namespace || '-'}</td>
                        <td className="py-1.5 font-mono">{formatAge(inst.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {instanceTotalPages > 1 && (
                <div className="flex items-center justify-between mt-2 text-xs text-slate-400">
                  <span>{filteredInstances.length} total</span>
                  <div className="flex items-center gap-1">
                    <button onClick={() => setInstancePage(p => Math.max(1, p - 1))} disabled={instancePage <= 1} className="px-2 py-0.5 rounded border border-slate-700 text-slate-400 disabled:opacity-40 hover:text-white">Prev</button>
                    <span className="min-w-[48px] text-center">{instancePage}/{instanceTotalPages}</span>
                    <button onClick={() => setInstancePage(p => Math.min(instanceTotalPages, p + 1))} disabled={instancePage >= instanceTotalPages} className="px-2 py-0.5 rounded border border-slate-700 text-slate-400 disabled:opacity-40 hover:text-white">Next</button>
                  </div>
                </div>
              )}
            </>
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
    </div>
  )
}
