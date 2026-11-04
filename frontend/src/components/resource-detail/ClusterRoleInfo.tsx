import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/services/api'
import { InfoSection, InfoRow, KeyValueTags, EventsSection, Th, Tx } from './DetailCommon'
import { fmtRel, fmtTs } from './detailFormat'
import { usePagination } from './usePagination'
import { ResourceLink } from './ResourceLink'
import { useResourceDetailOverlay } from '@/hooks/useResourceDetailOverlay'
import { usePermission } from '@/hooks/usePermission'
import { useReverseRoleBindings } from './role-info/useReverseRoleBindings'
import { referencedByContext, subjectsText, unreadableText } from './role-info/referencedBy'

interface Props {
  name: string
  rawJson?: Record<string, unknown>
}

export default function ClusterRoleInfo({ name, rawJson }: Props) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string) => t(key, { defaultValue: fallback })

  const { data: describe, isLoading } = useQuery({
    queryKey: ['clusterrole-describe', name],
    queryFn: () => api.describeClusterRole(name),
    enabled: !!name,
    retry: false,
  })

  const { bindings: referencedBy, error: crbError } = useReverseRoleBindings({ kind: 'ClusterRole', name })
  const { items: pagedReferencedBy, nav: referencedByNav } = usePagination(referencedBy, 10)
  // RoleBindings of every namespace may grant this ClusterRole there too (RBAC: "A RoleBinding can also reference a ClusterRole")
  const { bindings: roleBindings, error: rbError } = useReverseRoleBindings({ kind: 'ClusterRole', name, via: 'RoleBinding' })
  const { items: pagedRoleBindings, nav: roleBindingsNav } = usePagination(roleBindings, 10)
  const { clusterNamespaces } = usePermission()

  const extras = useMemo(
    () => referencedByContext({ bindings: referencedBy, error: crbError?.message }, { bindings: roleBindings, error: rbError?.message }, clusterNamespaces),
    [referencedBy, crbError, roleBindings, rbError, clusterNamespaces],
  )
  useResourceDetailOverlay({ kind: 'ClusterRole', name, describe, extras })

  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const labels = (describe?.labels as Record<string, string> | undefined) ?? (meta.labels as Record<string, string> | undefined) ?? {}
  const annotations = (describe?.annotations as Record<string, string> | undefined) ?? (meta.annotations as Record<string, string> | undefined) ?? {}
  const createdAt = (describe?.created_at as string | undefined) ?? (meta.creationTimestamp as string | undefined)
  const rules = Array.isArray(describe?.rules) ? describe.rules : []
  // the rule as the API writes it: { clusterRoleSelectors: [{ matchLabels, matchExpressions }] }
  const aggregationRule = Array.isArray(describe?.aggregation_rule?.clusterRoleSelectors) ? describe.aggregation_rule.clusterRoleSelectors : []

  if (isLoading) return <p className="text-slate-400">{tr('common.loading', 'Loading...')}</p>

  return (
    <div className="space-y-4">
      <InfoSection title="Basic Info">
        <div className="space-y-2">
          <InfoRow label="Kind" value="ClusterRole" />
          <InfoRow label="Name" value={name} />
          <InfoRow label="Created" value={createdAt ? `${fmtTs(createdAt)} (${fmtRel(createdAt)})` : '-'} />
          {describe?.uid && <InfoRow label="UID" value={<span className="font-mono text-[11px] break-all">{describe.uid}</span>} />}
          {describe?.resource_version && <InfoRow label="Resource Version" value={<span className="font-mono text-[11px]">{describe.resource_version}</span>} />}
          <InfoRow label="Rules Count" value={String(describe?.rules_count ?? rules.length)} />
        </div>
      </InfoSection>

      {aggregationRule.length > 0 && (
        <InfoSection title="Aggregation Rule">
          <div className="space-y-2">
            {aggregationRule.map((sel: any, idx: number) => {
              const matchLabels = sel.matchLabels as Record<string, string> | undefined
              const matchExpressions: any[] = Array.isArray(sel.matchExpressions) ? sel.matchExpressions : []
              return (
                <div key={idx} className="rounded-sm border border-slate-800 bg-slate-900/40 p-3 space-y-1.5">
                  <div className="text-xs text-slate-300">
                    <span className="text-[11px] text-slate-500 mr-2"><Tx>Match Labels:</Tx></span>
                    {matchLabels && Object.keys(matchLabels).length > 0 ? (
                      <div className="inline-flex flex-wrap gap-1 mt-0.5">
                        {Object.entries(matchLabels).map(([k, v]) => (
                          <span key={k} className="inline-flex rounded-sm border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-100 font-mono">
                            {k}={v}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="font-mono">-</span>
                    )}
                  </div>
                  {matchExpressions.length > 0 && (
                    <div className="text-xs text-slate-300">
                      <span className="text-[11px] text-slate-500 mr-2"><Tx>Match Expressions:</Tx></span>
                      <div className="inline-flex flex-wrap gap-1 mt-0.5">
                        {matchExpressions.map((e: any, i: number) => (
                          <span key={i} className="inline-flex rounded-sm border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-100 font-mono">
                            {`${e?.key} ${e?.operator} [${Array.isArray(e?.values) ? e.values.join(', ') : ''}]`}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </InfoSection>
      )}

      {rules.length > 0 && (
        <InfoSection title="Rules">
          <div className="space-y-2">
            {rules.map((rule: any, idx: number) => {
              const apiGroups = Array.isArray(rule.apiGroups) ? rule.apiGroups : []
              const resources = Array.isArray(rule.resources) ? rule.resources : []
              const verbs = Array.isArray(rule.verbs) ? rule.verbs : []
              const resourceNames = Array.isArray(rule.resourceNames) ? rule.resourceNames : []
              const nonResourceURLs = Array.isArray(rule.nonResourceURLs) ? rule.nonResourceURLs : []

              return (
                <div key={idx} className="rounded-sm border border-slate-800 bg-slate-900/40 p-3 space-y-2">
                  <div className="text-xs text-slate-300 space-y-1.5">
                    <div>
                      <span className="text-[11px] text-slate-500 mr-2"><Tx>API Groups:</Tx></span>
                      <span className="font-mono">
                        {apiGroups.length > 0
                          ? apiGroups.map((g: string) => g || '""').join(', ')
                          : '-'}
                      </span>
                    </div>
                    <div>
                      <span className="text-[11px] text-slate-500 mr-2"><Tx>Resources:</Tx></span>
                      <span className="font-mono">{resources.join(', ') || '-'}</span>
                    </div>
                    <div>
                      <span className="text-[11px] text-slate-500 mr-2"><Tx>Verbs:</Tx></span>
                      <div className="inline-flex flex-wrap gap-1 mt-0.5">
                        {verbs.map((verb: string) => (
                          <span key={verb} className="inline-flex rounded-sm border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-100 font-mono">
                            {verb}
                          </span>
                        ))}
                      </div>
                    </div>
                    {resourceNames.length > 0 && (
                      <div>
                        <span className="text-[11px] text-slate-500 mr-2"><Tx>Resource Names:</Tx></span>
                        <span className="font-mono">{resourceNames.join(', ')}</span>
                      </div>
                    )}
                    {nonResourceURLs.length > 0 && (
                      <div>
                        <span className="text-[11px] text-slate-500 mr-2"><Tx>Non-Resource URLs:</Tx></span>
                        <span className="font-mono">{nonResourceURLs.join(', ')}</span>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </InfoSection>
      )}

      <InfoSection title={crbError ? 'Referenced By ClusterRoleBindings' : 'Referenced By ClusterRoleBindings ({{n}})'} titleValues={{ n: referencedBy.length }}>
        {crbError ? (
          <p className="text-xs text-amber-300"><Tx text={unreadableText(crbError.forbidden)} values={{ kind: 'ClusterRoleBindings', role: 'ClusterRole' }} /></p>
        ) : referencedBy.length === 0 ? (
          <p className="text-xs text-slate-400"><Tx>No ClusterRoleBinding references this ClusterRole.</Tx></p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-slate-400">
                <tr>
                  <Th className="text-left py-1">ClusterRoleBinding</Th>
                  <Th className="text-left py-1">Subjects</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {pagedReferencedBy.map((b) => (
                  <tr key={b.name} className="text-slate-200">
                    <td className="py-1 pr-2">
                      <ResourceLink kind="ClusterRoleBinding" name={b.name} />
                    </td>
                    <td className="py-1 pr-2 text-slate-300">{subjectsText(b.subjects)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {referencedByNav}
          </div>
        )}
      </InfoSection>

      <InfoSection title={rbError ? 'Referenced By RoleBindings' : 'Referenced By RoleBindings ({{n}})'} titleValues={{ n: roleBindings.length }}>
        {clusterNamespaces && clusterNamespaces.length > 0 && (
          <p className="mb-2 text-xs text-amber-300">
            <Tx text="Your access to this cluster covers only the namespaces {{namespaces}}, so only RoleBindings there are listed; how many RoleBindings in other namespaces reference this ClusterRole is not known." values={{ namespaces: clusterNamespaces.join(', ') }} />
          </p>
        )}
        {rbError ? (
          <p className="text-xs text-amber-300"><Tx text={unreadableText(rbError.forbidden)} values={{ kind: 'RoleBindings', role: 'ClusterRole' }} /></p>
        ) : roleBindings.length === 0 ? (
          <p className="text-xs text-slate-400"><Tx>No RoleBinding references this ClusterRole.</Tx></p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-slate-400">
                <tr>
                  <Th className="text-left py-1">Namespace</Th>
                  <Th className="text-left py-1">RoleBinding</Th>
                  <Th className="text-left py-1">Subjects</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {pagedRoleBindings.map((b) => (
                  <tr key={`${b.namespace}/${b.name}`} className="text-slate-200">
                    <td className="py-1 pr-2">{b.namespace || '-'}</td>
                    <td className="py-1 pr-2">
                      <ResourceLink kind="RoleBinding" name={b.name} namespace={b.namespace} />
                    </td>
                    <td className="py-1 pr-2 text-slate-300">{subjectsText(b.subjects)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {roleBindingsNav}
          </div>
        )}
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

      <EventsSection events={describe?.events} error={describe?.events_error} loading={isLoading} />
    </div>
  )
}
