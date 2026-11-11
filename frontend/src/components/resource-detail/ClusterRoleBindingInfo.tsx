import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/services/api'
import { InfoSection, InfoRow, StatusBadge, KeyValueTags, EventsSection, Th, Tx } from './DetailCommon'
import { fmtRel, fmtTs } from './detailFormat'
import { useDrawerFollowsObject } from './useDrawerFollowsObject'
import { useServerPods } from './useServerPods'
import { ResourceLink } from './ResourceLink'
import { BindingSubjects } from './role-info/BindingSubjects'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { useResourceDetailOverlay } from '@/hooks/useResourceDetailOverlay'
import { podTableStatus } from '@/pages/workloads/pods/podHelpers'
import { DescribeFailure, DescribeStale } from './DescribeFailure'

interface Props {
  name: string
  rawJson?: Record<string, unknown>
}

export default function ClusterRoleBindingInfo({ name, rawJson }: Props) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string) => t(key, { defaultValue: fallback })
  const { open: openDetail } = useResourceDetail()

  const { data: describe, isLoading, error: describeError, dataUpdatedAt } = useQuery({
    queryKey: ['clusterrolebinding-describe', name],
    queryFn: () => api.describeClusterRoleBinding(name),
    enabled: !!name,
    retry: false,
  })
  useDrawerFollowsObject({
    enabled: !!name,
    describeKey: ['clusterrolebinding-describe', name],
    path: '/apis/rbac.authorization.k8s.io/v1/clusterrolebindings',
    name,
  })

  useResourceDetailOverlay({ kind: 'ClusterRoleBinding', name, describe })

  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const labels = (describe?.labels as Record<string, string> | undefined) ?? (meta.labels as Record<string, string> | undefined) ?? {}
  const annotations = (describe?.annotations as Record<string, string> | undefined) ?? (meta.annotations as Record<string, string> | undefined) ?? {}
  const createdAt = (describe?.created_at as string | undefined) ?? (meta.creationTimestamp as string | undefined)
  const subjects = Array.isArray(describe?.subjects) ? describe.subjects : []

  // ClusterRoleBinding 의 ServiceAccount subjects 는 (kind=SA, name, namespace=
  // 명시필수). 그 SA 로 도는 파드만 서버가 골라 한 쪽씩 준다(/pods/page service_account).
  const saSubjects: Array<{ name: string; namespace: string }> = subjects
    .filter((s: any) => s?.kind === 'ServiceAccount' && s?.namespace && s?.name)
    .map((s: any) => ({ name: s.name, namespace: s.namespace }))
  const { items: pagedBoundPods, total: boundTotal, nav: boundPodsNav } = useServerPods(
    saSubjects.length > 0 ? { service_account: saSubjects.map((s) => `${s.namespace}/${s.name}`).join(',') } : null,
  )

  if (isLoading) return <p className="text-slate-400">{tr('common.loading', 'Loading...')}</p>
  // nothing below was read: the bindings, keys and versions come from the describe answer only
  if (describeError && !describe) return <DescribeFailure error={describeError} className="py-4" />

  return (
    <div className="space-y-4">
      <DescribeStale error={describeError} readAt={dataUpdatedAt} />
      <InfoSection title="Basic Info">
        <div className="space-y-2">
          <InfoRow label="Kind" value="ClusterRoleBinding" />
          <InfoRow label="Name" value={name} />
          <InfoRow label="Created" value={createdAt ? `${fmtTs(createdAt)} (${fmtRel(createdAt)})` : '-'} />
          {describe?.uid && <InfoRow label="UID" value={<span className="font-mono text-[11px] break-all">{describe.uid}</span>} />}
          {describe?.resource_version && <InfoRow label="Resource Version" value={<span className="font-mono text-[11px]">{describe.resource_version}</span>} />}
        </div>
      </InfoSection>

      <InfoSection title="Role Reference">
        <div className="space-y-2">
          <InfoRow label="Kind" value={describe?.role_ref_kind ?? '-'} />
          <InfoRow label="Name" value={describe?.role_ref_name ? <ResourceLink kind="ClusterRole" name={describe.role_ref_name} /> : '-'} />
          <InfoRow label="API Group" value={describe?.role_ref_api_group ?? 'rbac.authorization.k8s.io'} />
        </div>
      </InfoSection>

      <BindingSubjects subjects={subjects} />

      {saSubjects.length > 0 && (
        <InfoSection title="Bound Pods via ServiceAccount Subjects ({{n}})" titleValues={{ n: boundTotal }}>
          {boundTotal === 0 ? (
            <p className="text-xs text-slate-400"><Tx>No pod uses any of the bound ServiceAccounts.</Tx></p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-slate-400">
                  <tr>
                    <Th className="text-left py-1">Namespace</Th>
                    <Th className="text-left py-1">Pod</Th>
                    <Th className="text-left py-1">SA</Th>
                    <Th className="text-left py-1">Status</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {pagedBoundPods.map((p: any) => (
                    <tr
                      key={`${p.namespace}/${p.name}`}
                      className="text-slate-200 hover:bg-slate-800/40 cursor-pointer"
                      onClick={() => openDetail({ kind: 'Pod', name: p.name, namespace: p.namespace })}
                    >
                      <td className="py-1 pr-2 font-mono">{p.namespace}</td>
                      <td className="py-1 pr-2 font-mono">{p.name}</td>
                      <td className="py-1 pr-2 font-mono text-slate-400">{p.service_account_name}</td>
                      <td className="py-1 pr-2"><StatusBadge status={podTableStatus(p)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {boundPodsNav}
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
