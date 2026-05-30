import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/services/api'
import {
  InfoSection,
  InfoRow,
  StatusBadge,
  KeyValueTags,
  fmtRel,
  fmtTs,
} from './DetailCommon'
import { ResourceLink } from './ResourceLink'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { useResourceDetailOverlay } from '@/hooks/useResourceDetailOverlay'

interface Props {
  name: string
  rawJson?: Record<string, unknown>
}

export default function ClusterRoleBindingInfo({ name, rawJson }: Props) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string) => t(key, { defaultValue: fallback })
  const { open: openDetail } = useResourceDetail()

  const { data: describe, isLoading } = useQuery({
    queryKey: ['clusterrolebinding-describe', name],
    queryFn: () => api.describeClusterRoleBinding(name),
    enabled: !!name,
    retry: false,
  })

  useResourceDetailOverlay({ kind: 'ClusterRoleBinding', name, describe })

  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const labels = (describe?.labels as Record<string, string> | undefined) ?? (meta.labels as Record<string, string> | undefined) ?? {}
  const annotations = (describe?.annotations as Record<string, string> | undefined) ?? (meta.annotations as Record<string, string> | undefined) ?? {}
  const createdAt = (describe?.created_at as string | undefined) ?? (meta.creationTimestamp as string | undefined)
  const subjects = Array.isArray(describe?.subjects) ? describe.subjects : []

  // ClusterRoleBinding 의 ServiceAccount subjects 는 (kind=SA, name, namespace=
  // 명시필수). cluster-wide Pod scan 후 (sa.namespace, sa.name) tuple 매칭.
  // 큰 cluster 에선 무거우니 max 50.
  const saSubjects: Array<{ name: string; namespace: string }> = subjects
    .filter((s: any) => s?.kind === 'ServiceAccount' && s?.namespace && s?.name)
    .map((s: any) => ({ name: s.name, namespace: s.namespace }))
  const { data: allPods } = useQuery({
    queryKey: ['clusterrolebinding-bound-pods', name],
    queryFn: () => api.getAllPods(),
    enabled: saSubjects.length > 0,
    staleTime: 30_000,
  })
  const saKeys = new Set(saSubjects.map((s) => `${s.namespace}/${s.name}`))
  const boundPods = (Array.isArray(allPods) ? allPods : [])
    .filter((p: any) => p?.service_account_name && saKeys.has(`${p.namespace}/${p.service_account_name}`))
    .slice(0, 50)

  if (isLoading) return <p className="text-slate-400">{tr('common.loading', 'Loading...')}</p>

  return (
    <div className="space-y-4">
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

      {subjects.length > 0 && (
        <InfoSection title={`Subjects (${subjects.length})`}>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {(() => {
              const counts: Record<string, number> = {}
              for (const s of subjects as any[]) {
                const k = String(s?.kind || 'Unknown')
                counts[k] = (counts[k] || 0) + 1
              }
              return Object.entries(counts).map(([k, c]) => (
                <span key={k} className="rounded border border-slate-700 bg-slate-800/60 px-2 py-0.5 text-[11px] text-slate-200">
                  {k}: <span className="font-mono">{String(c)}</span>
                </span>
              ))
            })()}
          </div>
          <div className="space-y-2">
            {subjects.map((subj: any, idx: number) => (
              <div key={idx} className="rounded border border-slate-800 bg-slate-900/40 p-3 space-y-1.5">
                <div className="text-xs text-slate-300 space-y-1">
                  <div>
                    <span className="text-[11px] uppercase tracking-wide text-slate-500 mr-2">Kind:</span>
                    <span className="font-mono">{subj.kind || '-'}</span>
                  </div>
                  <div>
                    <span className="text-[11px] uppercase tracking-wide text-slate-500 mr-2">Name:</span>
                    <span className="font-mono">{subj.name || '-'}</span>
                  </div>
                  {subj.namespace && (
                    <div>
                      <span className="text-[11px] uppercase tracking-wide text-slate-500 mr-2">Namespace:</span>
                      <span className="font-mono">{subj.namespace}</span>
                    </div>
                  )}
                  {subj.apiGroup && (
                    <div>
                      <span className="text-[11px] uppercase tracking-wide text-slate-500 mr-2">API Group:</span>
                      <span className="font-mono">{subj.apiGroup}</span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </InfoSection>
      )}

      {subjects.length === 0 && (
        <InfoSection title="Subjects">
          <p className="text-xs text-slate-500">No subjects defined.</p>
        </InfoSection>
      )}

      {saSubjects.length > 0 && (
        <InfoSection title={`Bound Pods via ServiceAccount Subjects (${boundPods.length})`}>
          {boundPods.length === 0 ? (
            <p className="text-xs text-slate-400">No pod uses any of the bound ServiceAccounts.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-slate-400">
                  <tr>
                    <th className="text-left py-1">Namespace</th>
                    <th className="text-left py-1">Pod</th>
                    <th className="text-left py-1">SA</th>
                    <th className="text-left py-1">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {boundPods.map((p: any) => (
                    <tr
                      key={`${p.namespace}/${p.name}`}
                      className="text-slate-200 hover:bg-slate-800/40 cursor-pointer"
                      onClick={() => openDetail({ kind: 'Pod', name: p.name, namespace: p.namespace })}
                    >
                      <td className="py-1 pr-2 font-mono">{p.namespace}</td>
                      <td className="py-1 pr-2 font-mono">{p.name}</td>
                      <td className="py-1 pr-2 font-mono text-slate-400">{p.service_account_name}</td>
                      <td className="py-1 pr-2"><StatusBadge status={String(p.phase ?? p.status ?? '-')} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {boundPods.length >= 50 && (
                <p className="text-[11px] text-amber-300 mt-1">Showing first 50 (truncated for performance).</p>
              )}
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
    </div>
  )
}
