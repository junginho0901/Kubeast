import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/services/api'
import {
  InfoSection,
  InfoRow,
  KeyValueTags,
  fmtRel,
  fmtTs,
} from './DetailCommon'
import { ResourceLink } from './ResourceLink'

interface Props {
  name: string
  rawJson?: Record<string, unknown>
}

export default function ClusterRoleBindingInfo({ name, rawJson }: Props) {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string) => t(key, { defaultValue: fallback })

  const { data: describe, isLoading } = useQuery({
    queryKey: ['clusterrolebinding-describe', name],
    queryFn: () => api.describeClusterRoleBinding(name),
    enabled: !!name,
    retry: false,
  })

  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const labels = (describe?.labels as Record<string, string> | undefined) ?? (meta.labels as Record<string, string> | undefined) ?? {}
  const annotations = (describe?.annotations as Record<string, string> | undefined) ?? (meta.annotations as Record<string, string> | undefined) ?? {}
  const createdAt = (describe?.created_at as string | undefined) ?? (meta.creationTimestamp as string | undefined)
  const subjects = Array.isArray(describe?.subjects) ? describe.subjects : []

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
