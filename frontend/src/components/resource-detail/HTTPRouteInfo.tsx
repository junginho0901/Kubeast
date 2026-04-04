import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { ConditionsTable, InfoSection, InfoRow, KeyValueTags, SummaryBadge, fmtRel, fmtTs } from './DetailCommon'
import { ResourceLink } from './ResourceLink'

interface Props {
  name: string
  namespace?: string
  rawJson?: Record<string, unknown>
}

type HTTPRouteDescribe = {
  uid?: string | null
  resource_version?: string | null
  hostnames?: string[]
  parent_refs?: Array<Record<string, any>>
  rules?: Array<Record<string, any>>
  parents?: Array<Record<string, any>>
  rule_count?: number
  parent_refs_count?: number
  backend_refs_count?: number
  status?: string | null
  accepted?: boolean
  resolved_refs?: boolean
  conditions?: Array<Record<string, unknown>>
  labels?: Record<string, string>
  annotations?: Record<string, string>
  finalizers?: string[]
  created_at?: string | null
  apiVersion?: string
  metadata?: Record<string, unknown>
  spec?: Record<string, unknown>
  status_detail?: Record<string, unknown>
}

function text(value: unknown): string {
  if (value == null) return '-'
  const s = String(value)
  return s.length > 0 ? s : '-'
}

function formatParentRef(parentRef: Record<string, any>): string {
  if (!parentRef || typeof parentRef !== 'object') return '-'
  const group = text(parentRef.group)
  const kind = text(parentRef.kind)
  const namespace = text(parentRef.namespace)
  const name = text(parentRef.name)
  const sectionName = text(parentRef.sectionName || parentRef.section_name)
  const port = text(parentRef.port)

  const head = [kind, group !== '-' ? `.${group}` : '', `/${name}`].join('')
  const extras = [
    namespace !== '-' ? `ns=${namespace}` : '',
    sectionName !== '-' ? `section=${sectionName}` : '',
    port !== '-' ? `port=${port}` : '',
  ].filter(Boolean)

  if (extras.length === 0) return head
  return `${head} (${extras.join(', ')})`
}

export default function HTTPRouteInfo({ name, namespace, rawJson }: Props) {
  const enabled = !!name && !!namespace
  const { data: describe, isLoading, isError } = useQuery({
    queryKey: ['httproute-describe', namespace, name],
    queryFn: () => api.describeHTTPRoute(namespace as string, name) as Promise<HTTPRouteDescribe>,
    enabled,
    retry: false,
  })

  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const spec = (rawJson?.spec ?? {}) as Record<string, unknown>
  const status = (rawJson?.status ?? {}) as Record<string, unknown>

  const hostnames = useMemo(() => {
    if (Array.isArray(describe?.hostnames)) return describe.hostnames
    return Array.isArray(spec?.hostnames) ? (spec.hostnames as string[]) : []
  }, [describe?.hostnames, spec?.hostnames])

  const parentRefs = useMemo(() => {
    if (Array.isArray(describe?.parent_refs)) return describe.parent_refs
    return Array.isArray(spec?.parentRefs) ? (spec.parentRefs as Array<Record<string, any>>) : []
  }, [describe?.parent_refs, spec?.parentRefs])

  const rules = useMemo(() => {
    if (Array.isArray(describe?.rules)) return describe.rules
    return Array.isArray(spec?.rules) ? (spec.rules as Array<Record<string, any>>) : []
  }, [describe?.rules, spec?.rules])

  const parents = useMemo(() => {
    if (Array.isArray(describe?.parents)) return describe.parents
    const detailParents = (describe?.status_detail as any)?.parents
    if (Array.isArray(detailParents)) return detailParents
    return Array.isArray(status?.parents) ? (status.parents as Array<Record<string, any>>) : []
  }, [describe?.parents, describe?.status_detail, status?.parents])

  const conditions = useMemo(() => {
    if (Array.isArray(describe?.conditions)) return describe.conditions
    const collected: Array<Record<string, unknown>> = []
    for (const parent of parents) {
      const parentConditions = Array.isArray(parent?.conditions) ? parent.conditions : []
      for (const condition of parentConditions) {
        if (condition && typeof condition === 'object') collected.push(condition)
      }
    }
    return collected
  }, [describe?.conditions, parents])

  const accepted = Boolean(
    describe?.accepted
    || conditions.some((c: any) => String(c?.type) === 'Accepted' && String(c?.status).toLowerCase() === 'true'),
  )
  const resolvedRefs = Boolean(
    describe?.resolved_refs
    || conditions.some((c: any) => String(c?.type) === 'ResolvedRefs' && String(c?.status).toLowerCase() === 'true'),
  )

  const statusText = describe?.status || (
    accepted
      ? 'Accepted'
      : resolvedRefs
        ? 'ResolvedRefs'
        : (() => {
            const firstTrue = conditions.find((c: any) => String(c?.status).toLowerCase() === 'true')
            if (firstTrue?.type) return String(firstTrue.type)
            const firstFalse = conditions.find((c: any) => String(c?.status).toLowerCase() === 'false')
            if (firstFalse?.type) return `${String(firstFalse.type)}(False)`
            return 'Unknown'
          })()
  )

  const labels = (describe?.labels ?? (meta.labels as Record<string, string> | undefined) ?? {})
  const annotations = (describe?.annotations ?? (meta.annotations as Record<string, string> | undefined) ?? {})
  const finalizers = Array.isArray(describe?.finalizers)
    ? describe.finalizers
    : (Array.isArray(meta?.finalizers) ? (meta.finalizers as string[]) : [])

  const createdAt = describe?.created_at ?? (meta.creationTimestamp as string | undefined)

  const ruleCount = Number(describe?.rule_count ?? rules.length)
  const parentRefCount = Number(describe?.parent_refs_count ?? parentRefs.length)
  const backendRefCount = Number(describe?.backend_refs_count ?? rules.reduce((sum, rule) => {
    const refs = Array.isArray(rule?.backendRefs) ? rule.backendRefs : []
    return sum + refs.length
  }, 0))

  return (
    <>
      <InfoSection title="HTTPRoute Info">
        {isLoading && <p className="text-xs text-slate-400 mb-2">Loading HTTPRoute details...</p>}
        {isError && <p className="text-xs text-red-400 mb-2">Failed to load describe data. Showing summary from list.</p>}
        <div className="flex flex-wrap gap-2 mb-3">
          <SummaryBadge label="Status" value={statusText} color="default" />
          <SummaryBadge label="Accepted" value={accepted ? 'Yes' : 'No'} color={accepted ? 'green' : 'amber'} />
          <SummaryBadge label="ResolvedRefs" value={resolvedRefs ? 'Yes' : 'No'} color={resolvedRefs ? 'green' : 'amber'} />
        </div>
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          {namespace && <InfoRow label="Namespace" value={namespace} />}
          <InfoRow label="Hostnames" value={hostnames.length > 0 ? hostnames.map((h) => h || '*').join(', ') : '*'} />
          <InfoRow label="Parent Refs" value={parentRefCount} />
          <InfoRow label="Rules" value={ruleCount} />
          <InfoRow label="Backend Refs" value={backendRefCount} />
          <InfoRow label="Created" value={createdAt ? `${fmtTs(createdAt)} (${fmtRel(createdAt)})` : '-'} />
        </div>
      </InfoSection>

      <InfoSection title="Parent Refs">
        {parentRefs.length === 0 ? (
          <p className="text-xs text-slate-400">(none)</p>
        ) : (
          <div className="space-y-2 text-xs">
            {parentRefs.map((parentRef, idx) => (
              <div key={`parent-ref-${idx}`} className="rounded border border-slate-800 p-2 text-slate-200 break-words">
                {parentRef.name ? (
                  <><ResourceLink kind={parentRef.kind || 'Gateway'} name={parentRef.name} namespace={parentRef.namespace || namespace} /> <span className="text-slate-400">{parentRef.sectionName ? `section=${parentRef.sectionName}` : ''}</span></>
                ) : formatParentRef(parentRef)}
              </div>
            ))}
          </div>
        )}
      </InfoSection>

      <InfoSection title="Rules">
        {rules.length === 0 ? (
          <p className="text-xs text-slate-400">(none)</p>
        ) : (
          <div className="space-y-3">
            {rules.map((rule, idx) => {
              const matches = Array.isArray(rule?.matches) ? rule.matches : []
              const backendRefs = Array.isArray(rule?.backendRefs) ? rule.backendRefs : []
              const filters = Array.isArray(rule?.filters) ? rule.filters : []

              return (
                <div key={`rule-${idx}`} className="rounded border border-slate-800 p-3">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                    <div className="text-slate-200 break-words"><span className="text-slate-400">Rule Name:</span> {text(rule?.name)}</div>
                    <div className="text-slate-200 break-words"><span className="text-slate-400">Matches:</span> {matches.length}</div>
                    <div className="text-slate-200 break-words"><span className="text-slate-400">Backend Refs:</span> {backendRefs.length}</div>
                    <div className="text-slate-200 break-words"><span className="text-slate-400">Filters:</span> {filters.length}</div>
                  </div>

                  {matches.length > 0 && (
                    <div className="mt-3 overflow-x-auto">
                      <table className="w-full text-xs table-fixed min-w-[620px]">
                        <thead className="text-slate-400">
                          <tr>
                            <th className="text-left py-1 w-[20%]">Path Type</th>
                            <th className="text-left py-1 w-[34%]">Path</th>
                            <th className="text-left py-1 w-[15%]">Method</th>
                            <th className="text-left py-1 w-[15%]">Headers</th>
                            <th className="text-left py-1 w-[16%]">Query Params</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800">
                          {matches.map((match, matchIdx) => (
                            <tr key={`match-${idx}-${matchIdx}`} className="text-slate-200">
                              <td className="py-1 pr-2 break-words">{text(match?.path?.type)}</td>
                              <td className="py-1 pr-2 break-words">{text(match?.path?.value)}</td>
                              <td className="py-1 pr-2 break-words">{text(match?.method)}</td>
                              <td className="py-1 pr-2">{Array.isArray(match?.headers) ? match.headers.length : 0}</td>
                              <td className="py-1 pr-2">{Array.isArray(match?.queryParams) ? match.queryParams.length : 0}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {backendRefs.length > 0 && (
                    <div className="mt-3 overflow-x-auto">
                      <table className="w-full text-xs table-fixed min-w-[620px]">
                        <thead className="text-slate-400">
                          <tr>
                            <th className="text-left py-1 w-[24%]">Name</th>
                            <th className="text-left py-1 w-[16%]">Namespace</th>
                            <th className="text-left py-1 w-[16%]">Kind</th>
                            <th className="text-left py-1 w-[16%]">Group</th>
                            <th className="text-left py-1 w-[14%]">Port</th>
                            <th className="text-left py-1 w-[14%]">Weight</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800">
                          {backendRefs.map((backendRef, backendRefIdx) => (
                            <tr key={`backend-ref-${idx}-${backendRefIdx}`} className="text-slate-200">
                              <td className="py-1 pr-2 break-words">{backendRef?.name ? <ResourceLink kind={backendRef?.kind || 'Service'} name={backendRef.name} namespace={backendRef?.namespace || namespace} /> : '-'}</td>
                              <td className="py-1 pr-2 break-words">{text(backendRef?.namespace)}</td>
                              <td className="py-1 pr-2 break-words">{text(backendRef?.kind)}</td>
                              <td className="py-1 pr-2 break-words">{text(backendRef?.group)}</td>
                              <td className="py-1 pr-2 break-words">{text(backendRef?.port)}</td>
                              <td className="py-1 pr-2 break-words">{text(backendRef?.weight)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </InfoSection>

      <InfoSection title="Parent Status">
        {parents.length === 0 ? (
          <p className="text-xs text-slate-400">(none)</p>
        ) : (
          <div className="space-y-3">
            {parents.map((parent, idx) => (
              <div key={`parent-status-${idx}`} className="rounded border border-slate-800 p-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs mb-2">
                  <div className="text-slate-200 break-words"><span className="text-slate-400">Controller:</span> {text(parent?.controllerName)}</div>
                  <div className="text-slate-200 break-words"><span className="text-slate-400">Parent Ref:</span> {formatParentRef(parent?.parentRef || {})}</div>
                </div>
                <ConditionsTable conditions={Array.isArray(parent?.conditions) ? parent.conditions : []} />
              </div>
            ))}
          </div>
        )}
      </InfoSection>

      <InfoSection title="Conditions">
        <ConditionsTable conditions={conditions as any[]} />
      </InfoSection>

      <InfoSection title="Lifecycle">
        <div className="space-y-2">
          <InfoRow label="UID" value={describe?.uid || text((describe?.metadata as any)?.uid)} />
          <InfoRow label="Resource Version" value={describe?.resource_version || text((describe?.metadata as any)?.resourceVersion)} />
          <InfoRow label="API Version" value={describe?.apiVersion || text(rawJson?.apiVersion)} />
          <InfoRow label="Finalizers" value={finalizers.join(', ') || '-'} />
        </div>
      </InfoSection>

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
