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

  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const labels = (describe?.labels as Record<string, string> | undefined) ?? (meta.labels as Record<string, string> | undefined) ?? {}
  const annotations = (describe?.annotations as Record<string, string> | undefined) ?? (meta.annotations as Record<string, string> | undefined) ?? {}
  const createdAt = (describe?.created_at as string | undefined) ?? (meta.creationTimestamp as string | undefined)
  const rules = Array.isArray(describe?.rules) ? describe.rules : []
  const aggregationRule = Array.isArray(describe?.aggregation_rule) ? describe.aggregation_rule : []

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
              return (
                <div key={idx} className="rounded border border-slate-800 bg-slate-900/40 p-3">
                  <div className="text-xs text-slate-300">
                    <span className="text-[11px] uppercase tracking-wide text-slate-500 mr-2">Match Labels:</span>
                    {matchLabels && Object.keys(matchLabels).length > 0 ? (
                      <div className="inline-flex flex-wrap gap-1 mt-0.5">
                        {Object.entries(matchLabels).map(([k, v]) => (
                          <span key={k} className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-100 font-mono">
                            {k}={v}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="font-mono">-</span>
                    )}
                  </div>
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
                <div key={idx} className="rounded border border-slate-800 bg-slate-900/40 p-3 space-y-2">
                  <div className="text-xs text-slate-300 space-y-1.5">
                    <div>
                      <span className="text-[11px] uppercase tracking-wide text-slate-500 mr-2">API Groups:</span>
                      <span className="font-mono">
                        {apiGroups.length > 0
                          ? apiGroups.map((g: string) => g || '""').join(', ')
                          : '-'}
                      </span>
                    </div>
                    <div>
                      <span className="text-[11px] uppercase tracking-wide text-slate-500 mr-2">Resources:</span>
                      <span className="font-mono">{resources.join(', ') || '-'}</span>
                    </div>
                    <div>
                      <span className="text-[11px] uppercase tracking-wide text-slate-500 mr-2">Verbs:</span>
                      <div className="inline-flex flex-wrap gap-1 mt-0.5">
                        {verbs.map((verb: string) => (
                          <span key={verb} className="inline-flex rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-100 font-mono">
                            {verb}
                          </span>
                        ))}
                      </div>
                    </div>
                    {resourceNames.length > 0 && (
                      <div>
                        <span className="text-[11px] uppercase tracking-wide text-slate-500 mr-2">Resource Names:</span>
                        <span className="font-mono">{resourceNames.join(', ')}</span>
                      </div>
                    )}
                    {nonResourceURLs.length > 0 && (
                      <div>
                        <span className="text-[11px] uppercase tracking-wide text-slate-500 mr-2">Non-Resource URLs:</span>
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
