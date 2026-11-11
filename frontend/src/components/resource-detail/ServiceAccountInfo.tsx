import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/services/api'
import { useResourceDetail } from '@/components/ResourceDetailContext'
import { InfoSection, InfoRow, KeyValueTags, EventsSection, StatusBadge, Th, Tx } from './DetailCommon'
import { fmtRel, fmtTs } from './detailFormat'
import { usePagination } from './usePagination'
import { ResourceLink } from './ResourceLink'
import { useResourceDetailOverlay } from '@/hooks/useResourceDetailOverlay'
import { podTableStatus } from '@/pages/workloads/pods/podHelpers'
import { useEffectivePermissions } from './service-account-info/useEffectivePermissions'
import { RULE_TABLE_COLUMNS, ruleRowNote, ruleTableCells } from './service-account-info/ruleTable'
import { useNamespacePodTable } from './useNamespacePodTable'
import { DescribeFailure } from './DescribeFailure'

interface Props {
  name: string
  namespace: string
  rawJson?: Record<string, unknown>
}

export default function ServiceAccountInfo({ name, namespace, rawJson }: Props) {
  const { t } = useTranslation()
  const { open: openDetail } = useResourceDetail()
  const tr = (key: string, fallback: string) => t(key, { defaultValue: fallback })

  const podsEnabled = !!namespace && !!name

  const usingPods = useNamespacePodTable({
    enabled: podsEnabled,
    namespace,
    filter: { service_account: `${namespace}/${name}` },
    queryKey: ['sa-using-pods', namespace, name],
    keeps: (p: any) => (p?.service_account_name ?? p?.spec?.serviceAccountName) === name,
  })

  const { bound: effectivePerms, loading: effectivePermsLoading, unreadable } = useEffectivePermissions({ namespace, name })
  const { items: pagedEffectivePerms, nav: effectivePermsNav } = usePagination(effectivePerms, 5)

  const { data: describe, isLoading, error: describeError } = useQuery({
    queryKey: ['serviceaccount-describe', namespace, name],
    queryFn: () => api.describeServiceAccount(namespace, name),
    enabled: !!namespace && !!name,
    retry: false,
  })

  useResourceDetailOverlay({ kind: 'ServiceAccount', name, namespace, describe })

  const meta = (rawJson?.metadata ?? {}) as Record<string, unknown>
  const labels = (describe?.labels as Record<string, string> | undefined) ?? (meta.labels as Record<string, string> | undefined) ?? {}
  const annotations = (describe?.annotations as Record<string, string> | undefined) ?? (meta.annotations as Record<string, string> | undefined) ?? {}
  const createdAt = (describe?.created_at as string | undefined) ?? (meta.creationTimestamp as string | undefined)
  const secretsList = Array.isArray(describe?.secrets_list) ? describe.secrets_list as string[] : []
  const imagePullSecrets = Array.isArray(describe?.image_pull_secrets) ? describe.image_pull_secrets as string[] : []
  const automount = describe?.automount_service_account_token

  if (isLoading) return <p className="text-slate-400">{tr('common.loading', 'Loading...')}</p>
  // nothing below was read: the bindings, keys and versions come from the describe answer only
  if (describeError) return <DescribeFailure error={describeError} className="py-4" />

  return (
    <div className="space-y-4">
      <InfoSection title="Basic Info">
        <div className="space-y-2">
          <InfoRow label="Kind" value="ServiceAccount" />
          <InfoRow label="Name" value={name} />
          <InfoRow label="Namespace" value={namespace} />
          <InfoRow label="Created" value={createdAt ? `${fmtTs(createdAt)} (${fmtRel(createdAt)})` : '-'} />
          {describe?.uid && <InfoRow label="UID" value={<span className="font-mono text-[11px] break-all">{describe.uid}</span>} />}
          {describe?.resource_version && <InfoRow label="Resource Version" value={<span className="font-mono text-[11px]">{describe.resource_version}</span>} />}
        </div>
      </InfoSection>

      <InfoSection title="ServiceAccount Details">
        <div className="space-y-2">
          {automount != null && <InfoRow label="Automount Token" value={automount ? 'Yes' : 'No'} />}
          <InfoRow label="Secrets" value={String(describe?.secrets ?? 0)} />
        </div>
      </InfoSection>

      {secretsList.length > 0 && (
        <InfoSection title="Secrets">
          <div className="space-y-1 text-xs text-slate-200">
            {secretsList.map((s: string) => (
              <div key={s}><ResourceLink kind="Secret" name={s} namespace={namespace} /></div>
            ))}
          </div>
        </InfoSection>
      )}

      {imagePullSecrets.length > 0 && (
        <InfoSection title="Image Pull Secrets">
          <div className="space-y-1 text-xs text-slate-200">
            {imagePullSecrets.map((s: string) => (
              <div key={s} className="font-mono">{s}</div>
            ))}
          </div>
        </InfoSection>
      )}

      <InfoSection
        title={effectivePermsLoading ? 'Effective Permissions ({{n}} bindings, loading…)' : unreadable.kinds.length > 0 && effectivePerms.length === 0 ? 'Effective Permissions' : effectivePerms.length === 1 ? 'Effective Permissions (1 binding)' : 'Effective Permissions ({{n}} bindings)'}
        titleValues={{ n: effectivePerms.length }}
      >
        {unreadable.kinds.length > 0 && (
          <p className="mb-2 text-xs text-amber-300" data-testid="sa-bindings-unreadable">
            <Tx
              text={unreadable.forbidden
                ? 'You may not list {{kinds}} here, so the bindings of this ServiceAccount cannot all be checked.'
                : 'Could not load {{kinds}}, so the bindings of this ServiceAccount cannot all be checked.'}
              values={{ kinds: unreadable.kinds.join(', ') }}
            />
          </p>
        )}
        {effectivePerms.length === 0 ? (
          unreadable.kinds.length > 0 ? null : (
            <p className="text-xs text-slate-400"><Tx>No RoleBinding or ClusterRoleBinding binds this ServiceAccount.</Tx></p>
          )
        ) : (
          <div className="space-y-3">
            {pagedEffectivePerms.map((b, i) => (
              <div key={`${b.binding_kind}/${b.binding_namespace ?? ''}/${b.binding_name}/${i}`} className="rounded-sm border border-slate-800 p-2">
                <div className="flex items-center gap-2 text-xs mb-1">
                  <span className="text-slate-400"><Tx>via</Tx></span>
                  <ResourceLink
                    kind={b.binding_kind}
                    name={b.binding_name}
                    namespace={b.binding_kind === 'RoleBinding' ? b.binding_namespace : undefined}
                  />
                  <span className="text-slate-500">→</span>
                  <ResourceLink
                    kind={b.role_kind}
                    name={b.role_name}
                    namespace={b.role_kind === 'Role' ? b.role_namespace : undefined}
                  />
                </div>
                {b.matched_by.length > 0 && (
                  <p className="mb-1 text-[11px] text-slate-400" data-testid="sa-binding-matched-by">
                    <Tx text="Applies through {{subjects}}" values={{ subjects: b.matched_by.join(' · ') }} />
                  </p>
                )}
                {b.error ? (
                  <p className="text-[11px] text-amber-300"><Tx text="Failed to load rules: {{error}}" values={{ error: String(b.error) }} /></p>
                ) : b.loading ? (
                  <p className="text-[11px] text-slate-500"><Tx>Loading rules...</Tx></p>
                ) : b.rules.length === 0 ? (
                  <p className="text-[11px] text-slate-500"><Tx>No rules.</Tx></p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-[11px]">
                      <thead className="text-slate-400">
                        <tr>
                          {RULE_TABLE_COLUMNS.map((column) => (
                            <Th key={column} className="text-left py-1 pr-2">{column}</Th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800">
                        {b.rules.map((r, ri) => {
                          const note = ruleRowNote(b.binding_kind, r)
                          return (
                            <tr key={ri} className="text-slate-200">
                              {ruleTableCells(r).map((cell, ci) => (
                                <td key={RULE_TABLE_COLUMNS[ci]} className={`py-1 pr-2 font-mono${RULE_TABLE_COLUMNS[ci] === 'Resource Names' ? ' text-slate-400' : ''}`}>
                                  {cell}
                                  {note && RULE_TABLE_COLUMNS[ci] === 'Non-Resource URLs' && (
                                    <span className="block mt-0.5 font-sans text-[10px] leading-4 text-amber-300" data-testid="sa-rule-url-note"><Tx text={note} /></span>
                                  )}
                                </td>
                              ))}
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}
            {effectivePermsNav}
          </div>
        )}
      </InfoSection>

      <InfoSection title="Pods Using This ServiceAccount ({{n}})" titleValues={{ n: usingPods.total }}>
        {usingPods.note}
        {usingPods.loading ? (
          <p className="text-xs text-slate-400"><Tx>Loading...</Tx></p>
        ) : usingPods.total === 0 ? (
          <p className="text-xs text-slate-400"><Tx>No pod in this namespace uses this ServiceAccount.</Tx></p>
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
