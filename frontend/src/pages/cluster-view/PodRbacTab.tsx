// Pod 상세 모달의 RBAC 탭. ClusterView.tsx 에서 추출 (Phase 3.1.d).
//
// ClusterView 의 가장 큰 sub-section (642줄). 자체 useState (include 토글) +
// useQuery (rbac fetch) + tr 의존 helper (formatMatchReason / getBindingMatchPathText)
// 다 보유. 순수 함수 (isAuthenticatedOnlyGrant / buildRbacPermissionSummary)
// 는 rbacUtils.ts 에서 import.

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { isAuthenticatedOnlyGrant, buildRbacPermissionSummary } from './rbacUtils'

interface PodLike {
  name: string
  namespace: string
}

interface Props {
  pod: PodLike
  tr: (key: string, fallback: string, options?: Record<string, any>) => string
}

export function PodRbacTab({ pod, tr }: Props) {
  const [includeAuthenticatedGroup, setIncludeAuthenticatedGroup] = useState(false)

  const { data: rbacData, isLoading: isRbacLoading, error: rbacError } = useQuery({
    queryKey: ['pod-rbac', pod.namespace, pod.name, includeAuthenticatedGroup],
    queryFn: async () => {
      return await api.getPodRbac(pod.namespace, pod.name, {
        include_authenticated: includeAuthenticatedGroup,
      })
    },
  })

  const formatMatchReason = (reason: string) => {
    switch (reason) {
      case 'serviceaccount':
        return tr('clusterView.rbac.serviceAccountDirect', 'ServiceAccount (direct)')
      case 'user:system:serviceaccount':
        return tr('clusterView.rbac.match.userServiceAccount', 'User(system:serviceaccount)')
      case 'group:serviceaccounts':
        return tr('clusterView.rbac.match.groupServiceAccounts', 'Group(system:serviceaccounts)')
      case 'group:system:authenticated':
        return tr('clusterView.rbac.match.groupAuthenticated', 'Group(system:authenticated)')
      default:
        return reason
    }
  }

  const getBindingMatchPathText = (binding: any) => {
    const matchedBy = binding?.matched_by
    if (!Array.isArray(matchedBy) || matchedBy.length === 0) return null
    const reasons = matchedBy
      .map((m: any) => m?.reason)
      .filter((r: any) => typeof r === 'string' && r.trim())
    if (!reasons.length) return null
    const unique = Array.from(new Set(reasons))
    return unique.map(formatMatchReason).join(' · ')
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <h3 className="text-lg font-semibold text-white">
            {tr('clusterView.rbac.title', 'RBAC')}
          </h3>
          <span
            className="px-2 py-1 rounded-sm bg-slate-700 text-slate-200 text-xs border border-slate-600"
            title={tr(
              'clusterView.rbac.tooltip',
              'This view summarizes RBAC (Role/RoleBinding/ClusterRole/ClusterRoleBinding) only. Actual allow/deny can differ due to Admission (OPA/Gatekeeper), NetworkPolicy/CNI, and controller behavior.',
            )}
          >
            {tr('clusterView.rbac.tooltipLabel', 'Note: RBAC only')}
          </span>
        </div>
        <div className="flex flex-col items-end gap-2">
          <label className="flex items-center gap-2 text-xs text-slate-300 select-none cursor-pointer">
            <input
              type="checkbox"
              checked={includeAuthenticatedGroup}
              onChange={(e) => setIncludeAuthenticatedGroup(e.target.checked)}
            />
            <span>
              {tr('clusterView.rbac.includeAuthenticated', 'Include broad (system:authenticated)')}
            </span>
          </label>
          <p className="text-slate-500 text-xs text-right max-w-[520px] leading-relaxed">
            {tr(
              'clusterView.rbac.includeAuthenticatedHint',
              'When checked, bindings matched by system:authenticated will be included.',
            )}
          </p>
        </div>
      </div>

      {isRbacLoading && (
        <div className="text-slate-400">{tr('clusterView.rbac.loading', 'Loading RBAC data...')}</div>
      )}

      {rbacError && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4">
          <p className="text-red-300 text-sm">
            {tr('clusterView.rbac.loadError', 'Failed to load RBAC data. (This may be due to permissions or API errors.)')}
          </p>
        </div>
      )}

      {rbacData && (
        <div className="space-y-6">
          <div className="bg-slate-800 rounded-lg p-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-slate-400">
                  {tr('clusterView.rbac.serviceAccountLabel', 'ServiceAccount')}
                </p>
                <p className="text-white font-medium">
                  {rbacData.service_account?.name || tr('clusterView.rbac.defaultName', 'default')}
                  {rbacData.service_account?.name === 'default' && (
                    <span className="ml-2 text-xs text-slate-400">
                      {tr('clusterView.rbac.defaultLabel', '(default)')}
                    </span>
                  )}
                </p>
                <p className="text-xs text-slate-500 mt-1 wrap-break-word">
                  system:serviceaccount:{rbacData?.pod?.namespace || pod.namespace}:{rbacData?.service_account?.name || tr('clusterView.rbac.defaultName', 'default')}
                </p>
              </div>
              <div>
                <p className="text-sm text-slate-400">
                  {tr('clusterView.rbac.bindingsLabel', 'Bindings')}
                </p>
                <p className="text-white font-medium">
                  {(() => {
                    const roleAll = (rbacData.role_bindings || []) as any[]
                    const roleAuthOnly = roleAll.filter(isAuthenticatedOnlyGrant).length
                    const clusterAll = (rbacData.cluster_role_bindings || []) as any[]
                    const clusterAuthOnly = clusterAll.filter(isAuthenticatedOnlyGrant).length

                    return (
                      <>
                        {tr('clusterView.rbac.roleBindingCount', 'RoleBinding {{count}}', { count: roleAll.length })}
                        {includeAuthenticatedGroup && roleAuthOnly > 0 && (
                          <span className="text-slate-400 text-sm">
                            {' '}
                            {tr('clusterView.rbac.broadCount', '(broad {{count}})', { count: roleAuthOnly })}
                          </span>
                        )}
                        {' '}
                        · {tr('clusterView.rbac.clusterRoleBindingCount', 'ClusterRoleBinding {{count}}', { count: clusterAll.length })}
                        {includeAuthenticatedGroup && clusterAuthOnly > 0 && (
                          <span className="text-slate-400 text-sm">
                            {' '}
                            {tr('clusterView.rbac.broadCount', '(broad {{count}})', { count: clusterAuthOnly })}
                          </span>
                        )}
                      </>
                    )
                  })()}
                </p>
              </div>
            </div>

            {Array.isArray(rbacData.errors) && rbacData.errors.length > 0 && (
              <div className="mt-4 bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
                <p className="text-yellow-300 text-sm font-medium mb-2">
                  {tr('clusterView.rbac.warningTitle', 'Warning')}
                </p>
                <ul className="text-yellow-200/90 text-sm list-disc pl-5 space-y-1">
                  {rbacData.errors.map((e: string, idx: number) => (
                    <li key={idx} className="wrap-break-word">{e}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {(() => {
            const { resourceItems, nonResourceItems } = buildRbacPermissionSummary(rbacData)
            const total = resourceItems.length + nonResourceItems.length
            return (
              <div className="bg-slate-800 rounded-lg p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h4 className="text-white font-semibold">
                      {tr('clusterView.rbac.summary.title', 'Permission summary')}
                    </h4>
                    <p className="text-slate-400 text-xs mt-1">
                      {tr('clusterView.rbac.summary.subtitle', 'Aggregated from displayed Role/ClusterRole rules.')}
                      {includeAuthenticatedGroup
                        ? ` ${tr('clusterView.rbac.summary.includeBroad', '(including broad)')}`
                        : ` ${tr('clusterView.rbac.summary.excludeBroad', '(excluding broad)')}`}
                    </p>
                  </div>
                  <div className="text-slate-300 text-sm shrink-0">
                    {tr('clusterView.rbac.summary.total', '{{count}} items', { count: total })}
                  </div>
                </div>

                {total === 0 ? (
                  <div className="text-slate-400 text-sm mt-3">
                    {tr('clusterView.rbac.summary.none', '(none)')}
                  </div>
                ) : (
                  <div className="mt-3 space-y-4">
                    {resourceItems.length > 0 && (
                      <div>
                        <p className="text-slate-300 text-sm font-medium mb-2">
                          {tr('clusterView.rbac.summary.resources', 'Resources')}
                        </p>
                        <div className="overflow-x-auto">
                          <table className="w-full min-w-[720px] text-sm table-auto">
                            <colgroup>
                              <col className="w-1/3" />
                              <col className="w-1/3" />
                              <col className="w-1/3" />
                            </colgroup>
                            <thead className="text-slate-400">
                              <tr>
                                <th className="text-left py-2 pr-4">
                                  {tr('clusterView.rbac.summary.table.apiGroup', 'apiGroup')}
                                </th>
                                <th className="text-left py-2 pr-4">
                                  {tr('clusterView.rbac.summary.table.resource', 'resource')}
                                </th>
                                <th className="text-left py-2 pr-4">
                                  {tr('clusterView.rbac.summary.table.verbs', 'verbs')}
                                </th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-700">
                              {resourceItems.map((it: any, idx: number) => (
                                <tr key={idx}>
                                  <td className="py-2 pr-4 text-slate-300 font-mono wrap-break-word">{it.apiGroup}</td>
                                  <td className="py-2 pr-4 text-white font-mono wrap-break-word">
                                    {it.resource}
                                    {it.resourceNames?.length ? (
                                      <span className="text-slate-400 text-xs ml-2">
                                        {tr('clusterView.rbac.summary.resourceNames', '(names: {{names}})', {
                                          names: it.resourceNames.join(', '),
                                        })}
                                      </span>
                                    ) : null}
                                  </td>
                                  <td className="py-2 pr-4 text-slate-200 font-mono wrap-break-word">
                                    {it.verbsList.join(', ') || tr('clusterView.rbac.summary.none', '(none)')}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    {nonResourceItems.length > 0 && (
                      <div>
                        <p className="text-slate-300 text-sm font-medium mb-2">
                          {tr('clusterView.rbac.summary.nonResourceUrls', 'Non-resource URLs')}
                        </p>
                        <div className="overflow-x-auto">
                          <table className="w-full min-w-[720px] text-sm table-auto">
                            <colgroup>
                              <col className="w-1/2" />
                              <col className="w-1/2" />
                            </colgroup>
                            <thead className="text-slate-400">
                              <tr>
                                <th className="text-left py-2 pr-4">
                                  {tr('clusterView.rbac.summary.table.url', 'url')}
                                </th>
                                <th className="text-left py-2 pr-4">
                                  {tr('clusterView.rbac.summary.table.verbs', 'verbs')}
                                </th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-700">
                              {nonResourceItems.map((it: any, idx: number) => (
                                <tr key={idx}>
                                  <td className="py-2 pr-4 text-white font-mono wrap-break-word">{it.nonResourceURL}</td>
                                  <td className="py-2 pr-4 text-slate-200 font-mono wrap-break-word">
                                    {it.verbsList.join(', ') || tr('clusterView.rbac.summary.none', '(none)')}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })()}

          <div className="space-y-3">
            <h4 className="text-white font-semibold">
              {tr('clusterView.rbac.roleBindingsTitle', 'RoleBindings (Namespace)')}
            </h4>
            {(() => {
              const all = (rbacData.role_bindings || []) as any[]
              const authenticatedOnly = all.filter(isAuthenticatedOnlyGrant)
              const normal = all.filter((b) => !isAuthenticatedOnlyGrant(b))

              return (
                <>
                  {normal.length ? (
                    <div className="space-y-2">
                      {normal.map((b: any) => (
                        <div key={`rb-${b.name}`} className="bg-slate-800 rounded-lg p-4">
                          <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0">
                              <p className="text-white font-medium wrap-break-word">{b.name}</p>
                              <p className="text-sm text-slate-400 wrap-break-word">
                                {b.role_ref?.kind}:{b.role_ref?.name}
                              </p>
                              {getBindingMatchPathText(b) && (
                                <p className="text-xs text-slate-500 mt-1 wrap-break-word">
                                  {tr('clusterView.rbac.matchingLabel', 'Matching')}: {getBindingMatchPathText(b)}
                                </p>
                              )}
                            </div>
                            <div className="text-right shrink-0">
                              <p className="text-sm text-slate-300">
                                {tr('clusterView.rbac.rulesCount', 'rules: {{count}}', { count: b.resolved_role?.rules?.length ?? 0 })}
                              </p>
                              {b.resolved_role?.error && (
                                <p className="text-xs text-yellow-300">{tr('clusterView.rbac.resolveFailed', 'resolve failed')}</p>
                              )}
                            </div>
                          </div>

                          <div className="mt-4 space-y-3">
                            <div>
                              <p className="text-sm text-slate-400 mb-1">{tr('clusterView.rbac.subjects', 'Subjects')}</p>
                              <div className="flex flex-wrap gap-2">
                                {(b.subjects || []).map((s: any, idx: number) => (
                                  <span
                                    key={idx}
                                    className="px-2 py-1 rounded-sm bg-slate-700 text-slate-200 text-xs wrap-break-word"
                                    title={`${s.kind || ''} ${s.namespace ? `${s.namespace}/` : ''}${s.name || ''}`}
                                  >
                                    {s.kind}:{s.namespace ? `${s.namespace}/` : ''}{s.name}
                                  </span>
                                ))}
                              </div>
                            </div>

                            {b.resolved_role?.error ? (
                              <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
                                <p className="text-yellow-200 text-sm wrap-break-word">{b.resolved_role.error}</p>
                              </div>
                            ) : (
                              <div>
                                <p className="text-sm text-slate-400 mb-2">{tr('clusterView.rbac.rulesLabel', 'Rules')}</p>
                                <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
                                  {(b.resolved_role?.rules || []).map((r: any, idx: number) => (
                                    <div key={idx} className="bg-slate-900 rounded-lg p-3 text-sm">
                                      <div className="flex flex-col gap-1">
                                        <div className="flex flex-wrap gap-2">
                                          <span className="text-slate-400">{tr('clusterView.rbac.verbsLabel', 'verbs')}</span>
                                          <span className="text-white font-mono wrap-break-word">{(r.verbs || []).join(', ') || tr('clusterView.rbac.none', '(none)')}</span>
                                        </div>
                                        <div className="flex flex-wrap gap-2">
                                          <span className="text-slate-400">{tr('clusterView.rbac.resourcesLabel', 'resources')}</span>
                                          <span className="text-white font-mono wrap-break-word">{(r.resources || []).join(', ') || tr('clusterView.rbac.none', '(none)')}</span>
                                          <span className="text-slate-500">{tr('clusterView.rbac.apiGroupsLabel', 'apiGroups')}</span>
                                          <span className="text-slate-200 font-mono wrap-break-word">{(r.api_groups || []).join(', ') || '(core)'}</span>
                                        </div>
                                        {(r.non_resource_urls || []).length > 0 && (
                                          <div className="flex flex-wrap gap-2">
                                            <span className="text-slate-400">{tr('clusterView.rbac.nonResourceUrlsLabel', 'nonResourceURLs')}</span>
                                            <span className="text-white font-mono wrap-break-word">{(r.non_resource_urls || []).join(', ')}</span>
                                          </div>
                                        )}
                                        {(r.resource_names || []).length > 0 && (
                                          <div className="flex flex-wrap gap-2">
                                            <span className="text-slate-400">{tr('clusterView.rbac.resourceNamesLabel', 'resourceNames')}</span>
                                            <span className="text-white font-mono wrap-break-word">{(r.resource_names || []).join(', ')}</span>
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-slate-400 text-sm">{tr('clusterView.rbac.none', '(none)')}</div>
                  )}

                  {includeAuthenticatedGroup && authenticatedOnly.length > 0 && (
                    <div className="bg-slate-800 rounded-lg p-4 border border-yellow-500/30">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <p className="text-yellow-200 font-medium wrap-break-word">
                            {tr('clusterView.rbac.broadRoleBindingTitle', 'Broad RoleBinding {{count}} (system:authenticated)', {
                              count: authenticatedOnly.length,
                            })}
                          </p>
                          <p className="text-xs text-slate-400 mt-1">
                            {tr(
                              'clusterView.rbac.broadRoleBindingHint',
                              'This can include most authenticated subjects and may overstate the actual permissions for this pod.',
                            )}
                          </p>
                        </div>
                        <span className="text-xs text-yellow-300 shrink-0">
                          {tr('clusterView.rbac.broadLabel', 'Broad')}
                        </span>
                      </div>

                      <div className="mt-3 space-y-2">
                        {authenticatedOnly.map((b: any) => (
                          <div key={`rb-broad-${b.name}`} className="bg-slate-900 rounded-lg p-4">
                            <div className="flex items-start justify-between gap-4">
                              <div className="min-w-0">
                                <p className="text-white font-medium wrap-break-word">{b.name}</p>
                                <p className="text-sm text-slate-400 wrap-break-word">
                                  {b.role_ref?.kind}:{b.role_ref?.name}
                                </p>
                                {getBindingMatchPathText(b) && (
                                  <p className="text-xs text-slate-500 mt-1 wrap-break-word">
                                    {tr('clusterView.rbac.matchingLabel', 'Matching')}: {getBindingMatchPathText(b)}
                                  </p>
                                )}
                              </div>
                              <div className="text-right shrink-0">
                                <p className="text-sm text-slate-300">
                                  {tr('clusterView.rbac.rulesCount', 'rules: {{count}}', { count: b.resolved_role?.rules?.length ?? 0 })}
                                </p>
                                <p className="text-xs text-yellow-300">{tr('clusterView.rbac.broadLabel', 'Broad')}</p>
                                {b.resolved_role?.error && (
                                  <p className="text-xs text-yellow-300">{tr('clusterView.rbac.resolveFailed', 'resolve failed')}</p>
                                )}
                              </div>
                            </div>

                            <div className="mt-4 space-y-3">
                              <div>
                                <p className="text-sm text-slate-400 mb-1">{tr('clusterView.rbac.subjects', 'Subjects')}</p>
                                <div className="flex flex-wrap gap-2">
                                  {(b.subjects || []).map((s: any, idx: number) => (
                                    <span
                                      key={idx}
                                      className="px-2 py-1 rounded-sm bg-slate-700 text-slate-200 text-xs wrap-break-word"
                                      title={`${s.kind || ''} ${s.namespace ? `${s.namespace}/` : ''}${s.name || ''}`}
                                    >
                                      {s.kind}:{s.namespace ? `${s.namespace}/` : ''}{s.name}
                                    </span>
                                  ))}
                                </div>
                              </div>

                              {b.resolved_role?.error ? (
                                <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
                                  <p className="text-yellow-200 text-sm wrap-break-word">{b.resolved_role.error}</p>
                                </div>
                              ) : (
                                <div>
                                  <p className="text-sm text-slate-400 mb-2">{tr('clusterView.rbac.rulesLabel', 'Rules')}</p>
                                  <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
                                    {(b.resolved_role?.rules || []).map((r: any, idx: number) => (
                                      <div key={idx} className="bg-slate-800 rounded-lg p-3 text-sm">
                                        <div className="flex flex-col gap-1">
                                          <div className="flex flex-wrap gap-2">
                                            <span className="text-slate-400">{tr('clusterView.rbac.verbsLabel', 'verbs')}</span>
                                            <span className="text-white font-mono wrap-break-word">{(r.verbs || []).join(', ') || tr('clusterView.rbac.none', '(none)')}</span>
                                          </div>
                                          <div className="flex flex-wrap gap-2">
                                            <span className="text-slate-400">{tr('clusterView.rbac.resourcesLabel', 'resources')}</span>
                                            <span className="text-white font-mono wrap-break-word">{(r.resources || []).join(', ') || tr('clusterView.rbac.none', '(none)')}</span>
                                            <span className="text-slate-500">{tr('clusterView.rbac.apiGroupsLabel', 'apiGroups')}</span>
                                            <span className="text-slate-200 font-mono wrap-break-word">{(r.api_groups || []).join(', ') || '(core)'}</span>
                                          </div>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )
            })()}
          </div>

          <div className="space-y-3">
            <h4 className="text-white font-semibold">
              {tr('clusterView.rbac.clusterRoleBindingsTitle', 'ClusterRoleBindings (Cluster)')}
            </h4>
            {(() => {
              const all = (rbacData.cluster_role_bindings || []) as any[]
              const authenticatedOnly = all.filter(isAuthenticatedOnlyGrant)
              const normal = all.filter((b) => !isAuthenticatedOnlyGrant(b))

              return (
                <>
                  {normal.length ? (
                    <div className="space-y-2">
                      {normal.map((b: any) => (
                        <div key={`crb-${b.name}`} className="bg-slate-800 rounded-lg p-4">
                          <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0">
                              <p className="text-white font-medium wrap-break-word">{b.name}</p>
                              <p className="text-sm text-slate-400 wrap-break-word">
                                {b.role_ref?.kind}:{b.role_ref?.name}
                              </p>
                              {getBindingMatchPathText(b) && (
                                <p className="text-xs text-slate-500 mt-1 wrap-break-word">
                                  {tr('clusterView.rbac.matchingLabel', 'Matching')}: {getBindingMatchPathText(b)}
                                </p>
                              )}
                            </div>
                            <div className="text-right shrink-0">
                              <p className="text-sm text-slate-300">
                                {tr('clusterView.rbac.rulesCount', 'rules: {{count}}', { count: b.resolved_role?.rules?.length ?? 0 })}
                              </p>
                              {b.resolved_role?.error && (
                                <p className="text-xs text-yellow-300">{tr('clusterView.rbac.resolveFailed', 'resolve failed')}</p>
                              )}
                            </div>
                          </div>

                          <div className="mt-4 space-y-3">
                            <div>
                              <p className="text-sm text-slate-400 mb-1">{tr('clusterView.rbac.subjects', 'Subjects')}</p>
                              <div className="flex flex-wrap gap-2">
                                {(b.subjects || []).map((s: any, idx: number) => (
                                  <span
                                    key={idx}
                                    className="px-2 py-1 rounded-sm bg-slate-700 text-slate-200 text-xs wrap-break-word"
                                    title={`${s.kind || ''} ${s.namespace ? `${s.namespace}/` : ''}${s.name || ''}`}
                                  >
                                    {s.kind}:{s.namespace ? `${s.namespace}/` : ''}{s.name}
                                  </span>
                                ))}
                              </div>
                            </div>

                            {b.resolved_role?.error ? (
                              <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
                                <p className="text-yellow-200 text-sm wrap-break-word">{b.resolved_role.error}</p>
                              </div>
                            ) : (
                              <div>
                                <p className="text-sm text-slate-400 mb-2">{tr('clusterView.rbac.rulesLabel', 'Rules')}</p>
                                <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
                                  {(b.resolved_role?.rules || []).map((r: any, idx: number) => (
                                    <div key={idx} className="bg-slate-900 rounded-lg p-3 text-sm">
                                      <div className="flex flex-col gap-1">
                                        <div className="flex flex-wrap gap-2">
                                          <span className="text-slate-400">{tr('clusterView.rbac.verbsLabel', 'verbs')}</span>
                                          <span className="text-white font-mono wrap-break-word">{(r.verbs || []).join(', ') || tr('clusterView.rbac.none', '(none)')}</span>
                                        </div>
                                        <div className="flex flex-wrap gap-2">
                                          <span className="text-slate-400">{tr('clusterView.rbac.resourcesLabel', 'resources')}</span>
                                          <span className="text-white font-mono wrap-break-word">{(r.resources || []).join(', ') || tr('clusterView.rbac.none', '(none)')}</span>
                                          <span className="text-slate-500">{tr('clusterView.rbac.apiGroupsLabel', 'apiGroups')}</span>
                                          <span className="text-slate-200 font-mono wrap-break-word">{(r.api_groups || []).join(', ') || '(core)'}</span>
                                        </div>
                                        {(r.non_resource_urls || []).length > 0 && (
                                          <div className="flex flex-wrap gap-2">
                                            <span className="text-slate-400">{tr('clusterView.rbac.nonResourceUrlsLabel', 'nonResourceURLs')}</span>
                                            <span className="text-white font-mono wrap-break-word">{(r.non_resource_urls || []).join(', ')}</span>
                                          </div>
                                        )}
                                        {(r.resource_names || []).length > 0 && (
                                          <div className="flex flex-wrap gap-2">
                                            <span className="text-slate-400">{tr('clusterView.rbac.resourceNamesLabel', 'resourceNames')}</span>
                                            <span className="text-white font-mono wrap-break-word">{(r.resource_names || []).join(', ')}</span>
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-slate-400 text-sm">{tr('clusterView.rbac.none', '(none)')}</div>
                  )}

                  {includeAuthenticatedGroup && authenticatedOnly.length > 0 && (
                    <div className="bg-slate-800 rounded-lg p-4 border border-yellow-500/30">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <p className="text-yellow-200 font-medium wrap-break-word">
                            {tr('clusterView.rbac.broadClusterRoleBindingTitle', 'Broad ClusterRoleBinding {{count}} (system:authenticated)', {
                              count: authenticatedOnly.length,
                            })}
                          </p>
                          <p className="text-xs text-slate-400 mt-1">
                            {tr(
                              'clusterView.rbac.broadClusterRoleBindingHint',
                              'This can include all authenticated subjects and may add noise. Use only for troubleshooting.',
                            )}
                          </p>
                        </div>
                        <span className="text-xs text-yellow-300 shrink-0">
                          {tr('clusterView.rbac.broadLabel', 'Broad')}
                        </span>
                      </div>

                      <div className="mt-3 space-y-2">
                        {authenticatedOnly.map((b: any) => (
                          <div key={`crb-broad-${b.name}`} className="bg-slate-900 rounded-lg p-4">
                            <div className="flex items-start justify-between gap-4">
                              <div className="min-w-0">
                                <p className="text-white font-medium wrap-break-word">{b.name}</p>
                                <p className="text-sm text-slate-400 wrap-break-word">
                                  {b.role_ref?.kind}:{b.role_ref?.name}
                                </p>
                                {getBindingMatchPathText(b) && (
                                  <p className="text-xs text-slate-500 mt-1 wrap-break-word">
                                    {tr('clusterView.rbac.matchingLabel', 'Matching')}: {getBindingMatchPathText(b)}
                                  </p>
                                )}
                              </div>
                              <div className="text-right shrink-0">
                                <p className="text-sm text-slate-300">
                                  {tr('clusterView.rbac.rulesCount', 'rules: {{count}}', { count: b.resolved_role?.rules?.length ?? 0 })}
                                </p>
                                <p className="text-xs text-yellow-300">{tr('clusterView.rbac.broadLabel', 'Broad')}</p>
                                {b.resolved_role?.error && (
                                  <p className="text-xs text-yellow-300">{tr('clusterView.rbac.resolveFailed', 'resolve failed')}</p>
                                )}
                              </div>
                            </div>

                            <div className="mt-4 space-y-3">
                              <div>
                                <p className="text-sm text-slate-400 mb-1">{tr('clusterView.rbac.subjects', 'Subjects')}</p>
                                <div className="flex flex-wrap gap-2">
                                  {(b.subjects || []).map((s: any, idx: number) => (
                                    <span
                                      key={idx}
                                      className="px-2 py-1 rounded-sm bg-slate-700 text-slate-200 text-xs wrap-break-word"
                                      title={`${s.kind || ''} ${s.namespace ? `${s.namespace}/` : ''}${s.name || ''}`}
                                    >
                                      {s.kind}:{s.namespace ? `${s.namespace}/` : ''}{s.name}
                                    </span>
                                  ))}
                                </div>
                              </div>

                              {b.resolved_role?.error ? (
                                <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
                                  <p className="text-yellow-200 text-sm wrap-break-word">{b.resolved_role.error}</p>
                                </div>
                              ) : (
                                <div>
                                  <p className="text-sm text-slate-400 mb-2">{tr('clusterView.rbac.rulesLabel', 'Rules')}</p>
                                  <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
                                    {(b.resolved_role?.rules || []).map((r: any, idx: number) => (
                                      <div key={idx} className="bg-slate-800 rounded-lg p-3 text-sm">
                                        <div className="flex flex-col gap-1">
                                          <div className="flex flex-wrap gap-2">
                                            <span className="text-slate-400">{tr('clusterView.rbac.verbsLabel', 'verbs')}</span>
                                            <span className="text-white font-mono wrap-break-word">{(r.verbs || []).join(', ') || tr('clusterView.rbac.none', '(none)')}</span>
                                          </div>
                                          <div className="flex flex-wrap gap-2">
                                            <span className="text-slate-400">{tr('clusterView.rbac.resourcesLabel', 'resources')}</span>
                                            <span className="text-white font-mono wrap-break-word">{(r.resources || []).join(', ') || tr('clusterView.rbac.none', '(none)')}</span>
                                            <span className="text-slate-500">{tr('clusterView.rbac.apiGroupsLabel', 'apiGroups')}</span>
                                            <span className="text-slate-200 font-mono wrap-break-word">{(r.api_groups || []).join(', ') || '(core)'}</span>
                                          </div>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )
            })()}
          </div>
        </div>
      )}
    </div>
  )
}
