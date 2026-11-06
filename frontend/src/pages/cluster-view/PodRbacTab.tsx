// Pod 상세 모달의 RBAC 탭. ClusterView.tsx 에서 추출 (Phase 3.1.d).
//
// 자체 useState (include 토글) + useQuery (rbac fetch) + tr 의존 helper
// (formatMatchReason / getBindingMatchPathText) 보유. 순수 함수는 rbacUtils.ts 에서 import.

import { useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { useAIContext } from '@/hooks/useAIContext'
import {
  buildRbacPermissionSummary,
  podRbacAIContext,
  rbacApiGroupsText,
  rbacBindingList,
  type RbacBindingList,
} from './rbacUtils'

interface PodLike {
  name: string
  namespace: string
}

interface Props {
  pod: PodLike
  tr: (key: string, fallback: string, options?: Record<string, any>) => string
}

type Tr = Props['tr']

function RbacRule({ rule, surface, tr }: { rule: any; surface: string; tr: Tr }) {
  const urls: string[] = rule.non_resource_urls || []
  const resources: string[] = rule.resources || []
  const names: string[] = rule.resource_names || []
  const none = tr('clusterView.rbac.none', 'None')
  return (
    <div data-testid="pod-rbac-rule" className={`${surface} rounded-lg p-3 text-sm`}>
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap gap-2">
          <span className="text-slate-400">{tr('clusterView.rbac.verbsLabel', 'verbs')}</span>
          <span className="text-ink font-mono wrap-break-word">{(rule.verbs || []).join(', ') || none}</span>
        </div>
        {/* A rule of URLs names no resource or API group. */}
        {(urls.length === 0 || resources.length > 0) && (
          <div className="flex flex-wrap gap-2">
            <span className="text-slate-400">{tr('clusterView.rbac.resourcesLabel', 'resources')}</span>
            <span className="text-ink font-mono wrap-break-word">{resources.join(', ') || none}</span>
            <span className="text-slate-500">{tr('clusterView.rbac.apiGroupsLabel', 'apiGroups')}</span>
            <span className="text-slate-200 font-mono wrap-break-word">{rbacApiGroupsText(rule.api_groups)}</span>
          </div>
        )}
        {urls.length > 0 && (
          <div className="flex flex-wrap gap-2">
            <span className="text-slate-400">{tr('clusterView.rbac.nonResourceUrlsLabel', 'nonResourceURLs')}</span>
            <span className="text-ink font-mono wrap-break-word">{urls.join(', ')}</span>
          </div>
        )}
        {names.length > 0 && (
          <div className="flex flex-wrap gap-2">
            <span className="text-slate-400">{tr('clusterView.rbac.resourceNamesLabel', 'resourceNames')}</span>
            <span className="text-ink font-mono wrap-break-word">{names.join(', ')}</span>
          </div>
        )}
      </div>
    </div>
  )
}

function RbacBindingCard({ binding: b, broad, matching, tr }: { binding: any; broad: boolean; matching: string | null; tr: Tr }) {
  const role = b.resolved_role
  const rules: any[] = role?.rules || []
  const none = tr('clusterView.rbac.none', 'None')
  return (
    <div className={`${broad ? 'bg-slate-900' : 'bg-slate-800'} rounded-lg p-4`} data-testid="pod-rbac-binding" data-name={b.name}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-ink font-medium wrap-break-word" data-testid="pod-rbac-binding-name">{b.name}</p>
          <p className="text-sm text-slate-400 wrap-break-word">
            {b.role_ref?.kind}:{b.role_ref?.name}
          </p>
          {matching && (
            <p className="text-xs text-slate-500 mt-1 wrap-break-word">
              {tr('clusterView.rbac.matchingLabel', 'Matching')}: {matching}
            </p>
          )}
        </div>
        <div className="text-right shrink-0">
          <p className="text-sm text-slate-300">
            {tr('clusterView.rbac.rulesCount', 'rules: {{count}}', { count: role?.error ? '-' : rules.length })}
          </p>
          {broad && <p className="text-xs text-yellow-300">{tr('clusterView.rbac.broadLabel', 'Broad')}</p>}
          {role?.error && (
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

        {role?.error ? (
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
            <p className="text-yellow-200 text-sm wrap-break-word">{role.error}</p>
          </div>
        ) : (
          <div>
            <p className="text-sm text-slate-400 mb-2">{tr('clusterView.rbac.rulesLabel', 'Rules')}</p>
            {rules.length ? (
              <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1" data-testid="pod-rbac-rules">
                {rules.map((r: any, idx: number) => (
                  <RbacRule key={idx} rule={r} surface={broad ? 'bg-slate-800' : 'bg-slate-900'} tr={tr} />
                ))}
              </div>
            ) : (
              <p className="text-slate-400 text-sm">{none}</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

interface SectionProps {
  testId: string
  keyPrefix: string
  title: string
  broadTitle: string
  broadHint: string
  list: RbacBindingList
  includeBroad: boolean
  matchingOf: (binding: any) => string | null
  tr: Tr
}

function RbacBindingSection({ testId, keyPrefix, title, broadTitle, broadHint, list, includeBroad, matchingOf, tr }: SectionProps) {
  return (
    <div className="space-y-3" data-testid={testId}>
      <h4 className="text-ink font-semibold">{title}</h4>
      {!list.read && (
        <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
          <p className="text-yellow-200 text-sm wrap-break-word">
            {tr('clusterView.rbac.listUnreadable', 'Could not read this list. The cluster answered:')} {list.error}
          </p>
        </div>
      )}
      {list.read && list.normal.length > 0 && (
        <div className="space-y-2">
          {list.normal.map((b: any) => (
            <RbacBindingCard key={`${keyPrefix}-${b.name}`} binding={b} broad={false} matching={matchingOf(b)} tr={tr} />
          ))}
        </div>
      )}
      {list.read && list.all.length === 0 && (
        <div className="text-slate-400 text-sm">{tr('clusterView.rbac.none', 'None')}</div>
      )}

      {includeBroad && list.broad.length > 0 && (
        <div className="bg-slate-800 rounded-lg p-4 border border-yellow-500/30">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-yellow-200 font-medium wrap-break-word">{broadTitle}</p>
              <p className="text-xs text-slate-400 mt-1">{broadHint}</p>
            </div>
            <span className="text-xs text-yellow-300 shrink-0">{tr('clusterView.rbac.broadLabel', 'Broad')}</span>
          </div>

          <div className="mt-3 space-y-2">
            {list.broad.map((b: any) => (
              <RbacBindingCard key={`${keyPrefix}-broad-${b.name}`} binding={b} broad matching={matchingOf(b)} tr={tr} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
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
    // The toggle asks again: what it showed stays until the new answer comes, so the page does not blink.
    placeholderData: keepPreviousData,
  })

  useAIContext(rbacData ? podRbacAIContext(rbacData, pod) : null, [rbacData, pod.name, pod.namespace])

  const formatMatchReason = (reason: string) => {
    switch (reason) {
      case 'serviceaccount':
        return tr('clusterView.rbac.serviceAccountDirect', 'ServiceAccount (direct)')
      case 'user:system:serviceaccount':
        return tr('clusterView.rbac.match.userServiceAccount', 'User(system:serviceaccount)')
      case 'group:serviceaccounts':
        return tr('clusterView.rbac.match.groupServiceAccounts', 'Group(system:serviceaccounts)')
      case 'group:serviceaccounts:namespace':
        return tr('clusterView.rbac.match.groupServiceAccountsNamespace', 'Group(system:serviceaccounts:{{namespace}})', {
          namespace: pod.namespace,
        })
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

  const loadErrorDetail: string | undefined = (rbacError as any)?.response?.data?.detail
  const roleBindings = rbacBindingList(rbacData, 'role_bindings')
  const clusterRoleBindings = rbacBindingList(rbacData, 'cluster_role_bindings')
  const serviceAccountName = rbacData?.service_account?.name || '-'

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <h3 className="text-lg font-semibold text-ink">
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
          {loadErrorDetail && <p className="text-red-300 text-xs mt-1 wrap-break-word">{loadErrorDetail}</p>}
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
                <p className="text-ink font-medium">
                  {serviceAccountName}
                  {serviceAccountName === 'default' && (
                    <span className="ml-2 text-xs text-slate-400">
                      {tr('clusterView.rbac.defaultLabel', '(default)')}
                    </span>
                  )}
                </p>
                <p className="text-xs text-slate-500 mt-1 wrap-break-word" data-testid="pod-rbac-service-account">
                  system:serviceaccount:{rbacData.pod?.namespace || pod.namespace}:{serviceAccountName}
                </p>
              </div>
              <div>
                <p className="text-sm text-slate-400">
                  {tr('clusterView.rbac.bindingsLabel', 'Bindings')}
                </p>
                <p className="text-ink font-medium" data-testid="pod-rbac-binding-counts">
                  {roleBindings.read
                    ? tr('clusterView.rbac.roleBindingCount', 'RoleBinding {{count}}', { count: roleBindings.all.length })
                    : 'RoleBinding -'}
                  {includeAuthenticatedGroup && roleBindings.broad.length > 0 && (
                    <span className="text-slate-400 text-sm">
                      {' '}
                      {tr('clusterView.rbac.broadCount', '(broad {{count}})', { count: roleBindings.broad.length })}
                    </span>
                  )}
                  {' '}
                  · {clusterRoleBindings.read
                    ? tr('clusterView.rbac.clusterRoleBindingCount', 'ClusterRoleBinding {{count}}', { count: clusterRoleBindings.all.length })
                    : 'ClusterRoleBinding -'}
                  {includeAuthenticatedGroup && clusterRoleBindings.broad.length > 0 && (
                    <span className="text-slate-400 text-sm">
                      {' '}
                      {tr('clusterView.rbac.broadCount', '(broad {{count}})', { count: clusterRoleBindings.broad.length })}
                    </span>
                  )}
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
                    <li key={idx} className="wrap-break-word" data-testid="pod-rbac-warning">{e}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {(() => {
            const { resourceItems, nonResourceItems, incomplete } = buildRbacPermissionSummary(rbacData)
            const total = resourceItems.length + nonResourceItems.length
            return (
              <div className="bg-slate-800 rounded-lg p-4" data-testid="pod-rbac-summary">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h4 className="text-ink font-semibold">
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
                    {incomplete && total === 0 ? '-' : tr('clusterView.rbac.summary.total', '{{count}} items', { count: total })}
                  </div>
                </div>

                {incomplete && (
                  <p className="text-yellow-200 text-sm mt-3 wrap-break-word">
                    {tr('clusterView.rbac.summary.incomplete', 'Some bindings or roles could not be read, so permissions may be missing from this list.')}
                  </p>
                )}

                {total === 0 && !incomplete && (
                  <div className="text-slate-400 text-sm mt-3">
                    {tr('clusterView.rbac.summary.none', 'None')}
                  </div>
                )}

                {total > 0 && (
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
                            <tbody className="divide-y divide-slate-700" data-testid="pod-rbac-resources">
                              {resourceItems.map((it: any, idx: number) => (
                                <tr key={idx}>
                                  <td className="py-2 pr-4 text-slate-300 font-mono wrap-break-word">{it.apiGroup}</td>
                                  <td className="py-2 pr-4 text-ink font-mono wrap-break-word">
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
                                    {it.verbsList.join(', ') || tr('clusterView.rbac.summary.none', 'None')}
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
                            <tbody className="divide-y divide-slate-700" data-testid="pod-rbac-urls">
                              {nonResourceItems.map((it: any, idx: number) => (
                                <tr key={idx}>
                                  <td className="py-2 pr-4 text-ink font-mono wrap-break-word">{it.nonResourceURL}</td>
                                  <td className="py-2 pr-4 text-slate-200 font-mono wrap-break-word">
                                    {it.verbsList.join(', ') || tr('clusterView.rbac.summary.none', 'None')}
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

          <RbacBindingSection
            testId="pod-rbac-role-bindings"
            keyPrefix="rb"
            title={tr('clusterView.rbac.roleBindingsTitle', 'RoleBindings (Namespace)')}
            broadTitle={tr('clusterView.rbac.broadRoleBindingTitle', 'Broad RoleBinding {{count}} (system:authenticated)', {
              count: roleBindings.broad.length,
            })}
            broadHint={tr(
              'clusterView.rbac.broadRoleBindingHint',
              'This can include most authenticated subjects and may overstate the actual permissions for this pod.',
            )}
            list={roleBindings}
            includeBroad={includeAuthenticatedGroup}
            matchingOf={getBindingMatchPathText}
            tr={tr}
          />

          <RbacBindingSection
            testId="pod-rbac-cluster-role-bindings"
            keyPrefix="crb"
            title={tr('clusterView.rbac.clusterRoleBindingsTitle', 'ClusterRoleBindings (Cluster)')}
            broadTitle={tr('clusterView.rbac.broadClusterRoleBindingTitle', 'Broad ClusterRoleBinding {{count}} (system:authenticated)', {
              count: clusterRoleBindings.broad.length,
            })}
            broadHint={tr(
              'clusterView.rbac.broadClusterRoleBindingHint',
              'This can include all authenticated subjects and may add noise. Use only for troubleshooting.',
            )}
            list={clusterRoleBindings}
            includeBroad={includeAuthenticatedGroup}
            matchingOf={getBindingMatchPathText}
            tr={tr}
          />
        </div>
      )}
    </div>
  )
}
