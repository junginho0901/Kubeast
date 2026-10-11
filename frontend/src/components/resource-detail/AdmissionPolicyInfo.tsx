import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { InfoSection, InfoRow, SummaryBadge, KeyValueTags, Th, Tx } from './DetailCommon'
import { fmtRel } from './detailFormat'
import { useResourceDetailOverlay } from '@/hooks/useResourceDetailOverlay'

// ValidatingAdmissionPolicy / MutatingAdmissionPolicy drawer: the policy's
// spec as the API writes it (match constraints, conditions, variables, the
// CEL validations or mutations), the type-checking status and its bindings.

interface Props {
  name: string
  kind: 'ValidatingAdmissionPolicy' | 'MutatingAdmissionPolicy'
}

export default function AdmissionPolicyInfo({ name, kind }: Props) {
  const validating = kind === 'ValidatingAdmissionPolicy'

  const { data: desc, isLoading } = useQuery({
    queryKey: ['admissionpolicy-describe', kind, name],
    queryFn: () => (validating ? api.describeValidatingAdmissionPolicy(name) : api.describeMutatingAdmissionPolicy(name)),
    staleTime: 10_000,
    retry: 1,
  })

  useResourceDetailOverlay({ kind, name, describe: desc })

  if (isLoading) {
    return <div className="text-xs text-slate-400 py-4 text-center"><Tx>Loading...</Tx></div>
  }
  if (!desc) {
    return <div className="text-xs text-slate-400 py-4 text-center"><Tx>No data</Tx></div>
  }

  const spec: any = desc.spec || {}
  const status: any = desc.status || {}
  const bindings: any[] = Array.isArray(desc.bindings) ? desc.bindings : []
  const match: any = spec.matchConstraints || {}
  const rules: any[] = Array.isArray(match.resourceRules) ? match.resourceRules : []
  const exclude: any[] = Array.isArray(match.excludeResourceRules) ? match.excludeResourceRules : []
  const matchConditions: any[] = Array.isArray(spec.matchConditions) ? spec.matchConditions : []
  const variables: any[] = Array.isArray(spec.variables) ? spec.variables : []
  const validations: any[] = Array.isArray(spec.validations) ? spec.validations : []
  const mutations: any[] = Array.isArray(spec.mutations) ? spec.mutations : []
  const auditAnnotations: any[] = Array.isArray(spec.auditAnnotations) ? spec.auditAnnotations : []
  const warnings: any[] = Array.isArray(status.typeChecking?.expressionWarnings) ? status.typeChecking.expressionWarnings : []
  const conditions: any[] = Array.isArray(status.conditions) ? status.conditions : []
  const ruleCount = validating ? validations.length : mutations.length

  return (
    <div className="space-y-4" data-testid="admission-policy-info">
      <div className="flex flex-wrap gap-2">
        <SummaryBadge label={validating ? 'Validations' : 'Mutations'} value={ruleCount} color={ruleCount > 0 ? 'green' : 'default'} />
        <SummaryBadge label="Bindings" value={bindings.length} color={bindings.length > 0 ? 'green' : 'amber'} />
        <SummaryBadge label="Failure Policy" value={desc.failure_policy || 'Fail'} color={desc.failure_policy === 'Ignore' ? 'amber' : 'default'} />
      </div>

      <InfoSection title="Summary">
        <div className="space-y-2">
          <InfoRow label="Name" value={name} />
          <InfoRow label="UID" value={desc.uid || '-'} />
          <InfoRow label="Created" value={fmtRel(desc.created_at)} />
          <InfoRow label="Resource Version" value={desc.resource_version || '-'} />
          <InfoRow label="Failure Policy" value={desc.failure_policy || 'Fail'} />
          <InfoRow label="Param Kind" value={desc.param_kind || '-'} />
          {!validating && <InfoRow label="Reinvocation Policy" value={desc.reinvocation_policy || 'Never'} />}
          <InfoRow label="Match Policy" value={match.matchPolicy || 'Equivalent'} />
        </div>
      </InfoSection>

      <InfoSection title="Match Constraints">
        <div className="space-y-2">
          <SelectorRow label="Namespace Selector" selector={match.namespaceSelector} />
          <SelectorRow label="Object Selector" selector={match.objectSelector} />
          <RulesTable label="Resource Rules" rules={rules} />
          {exclude.length > 0 && <RulesTable label="Exclude Resource Rules" rules={exclude} />}
        </div>
      </InfoSection>

      {matchConditions.length > 0 && (
        <InfoSection title="Match Conditions">
          <ExpressionList items={matchConditions.map((c) => ({ name: c?.name, expression: c?.expression }))} />
        </InfoSection>
      )}

      {variables.length > 0 && (
        <InfoSection title="Variables">
          <ExpressionList items={variables.map((v) => ({ name: v?.name, expression: v?.expression }))} />
        </InfoSection>
      )}

      {validating ? (
        <InfoSection title="Validations">
          {validations.length === 0 ? <div className="text-xs text-slate-400">-</div> : (
            <div className="space-y-2">
              {validations.map((v, i) => (
                <div key={i} className="rounded-sm border border-slate-800 bg-slate-900/40 px-2 py-1.5 space-y-1" data-testid="admission-policy-validation">
                  <p className="font-mono text-[11px] text-slate-200 break-all">{v?.expression || '-'}</p>
                  {v?.message && <p className="text-[11px] text-slate-300"><Tx>Message</Tx>: {v.message}</p>}
                  {v?.messageExpression && <p className="text-[11px] text-slate-300"><Tx>Message Expression</Tx>: <span className="font-mono break-all">{v.messageExpression}</span></p>}
                  {v?.reason && <p className="text-[11px] text-slate-400"><Tx>Reason</Tx>: {v.reason}</p>}
                </div>
              ))}
            </div>
          )}
        </InfoSection>
      ) : (
        <InfoSection title="Mutations">
          {mutations.length === 0 ? <div className="text-xs text-slate-400">-</div> : (
            <div className="space-y-2">
              {mutations.map((m, i) => (
                <div key={i} className="rounded-sm border border-slate-800 bg-slate-900/40 px-2 py-1.5 space-y-1" data-testid="admission-policy-mutation">
                  <p className="text-[11px] text-slate-400"><Tx>Patch Type</Tx>: {m?.patchType || '-'}</p>
                  <p className="font-mono text-[11px] text-slate-200 break-all">{m?.applyConfiguration?.expression || m?.jsonPatch?.expression || '-'}</p>
                </div>
              ))}
            </div>
          )}
        </InfoSection>
      )}

      {auditAnnotations.length > 0 && (
        <InfoSection title="Audit Annotations">
          <ExpressionList items={auditAnnotations.map((a) => ({ name: a?.key, expression: a?.valueExpression }))} />
        </InfoSection>
      )}

      {(warnings.length > 0 || conditions.length > 0) && (
        <InfoSection title="Type Checking">
          <div className="space-y-2">
            {warnings.map((w, i) => (
              <div key={i} className="rounded-sm border border-amber-700/60 bg-amber-900/20 px-2 py-1.5">
                <p className="text-[11px] text-amber-300 font-mono">{w?.fieldRef || '-'}</p>
                <p className="text-[11px] text-slate-200 break-all">{w?.warning || '-'}</p>
              </div>
            ))}
            {conditions.map((c, i) => (
              <InfoRow key={i} label={c?.type || '-'} value={`${c?.status || '-'}${c?.reason ? ` · ${c.reason}` : ''}${c?.message ? ` · ${c.message}` : ''}`} />
            ))}
          </div>
        </InfoSection>
      )}

      <InfoSection title="Bindings">
        {bindings.length === 0 ? <div className="text-xs text-slate-400">-</div> : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs border border-slate-700 rounded-sm" data-testid="admission-policy-bindings">
              <thead>
                <tr className="bg-slate-800/60 text-slate-400">
                  <Th className="text-left px-2 py-1.5">Name</Th>
                  {validating && <Th className="text-left px-2 py-1.5">Validation Actions</Th>}
                  <Th className="text-left px-2 py-1.5">Param Ref</Th>
                  <Th className="text-left px-2 py-1.5">Namespace Selector</Th>
                  <Th className="text-left px-2 py-1.5">Resource Rules</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700">
                {bindings.map((b) => {
                  const bs: any = b?.spec || {}
                  const mr: any = bs.matchResources || {}
                  const brules: any[] = Array.isArray(mr.resourceRules) ? mr.resourceRules : []
                  return (
                    <tr key={b.name} className="text-slate-200">
                      <td className="px-2 py-1.5 font-medium text-white break-all">{b.name}</td>
                      {validating && <td className="px-2 py-1.5">{Array.isArray(bs.validationActions) && bs.validationActions.length > 0 ? bs.validationActions.join(', ') : '-'}</td>}
                      <td className="px-2 py-1.5 break-all">{paramRefText(bs.paramRef)}</td>
                      <td className="px-2 py-1.5 break-all">{selectorText(mr.namespaceSelector) || '-'}</td>
                      <td className="px-2 py-1.5">{brules.length === 0 ? '-' : brules.map((r, i) => <span key={i} className="block">{ruleText(r)}</span>)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </InfoSection>

      <InfoSection title="Labels">
        <KeyValueTags data={desc.labels} />
      </InfoSection>

      <InfoSection title="Annotations">
        <KeyValueTags data={desc.annotations} />
      </InfoSection>
    </div>
  )
}

function ExpressionList({ items }: { items: { name?: string; expression?: string }[] }) {
  return (
    <div className="space-y-1">
      {items.map((it, i) => (
        <div key={i} className="rounded-sm border border-slate-800 bg-slate-900/40 px-2 py-1.5">
          <p className="text-[11px] text-slate-300">{it.name || '-'}</p>
          <p className="font-mono text-[11px] text-slate-200 break-all">{it.expression || '-'}</p>
        </div>
      ))}
    </div>
  )
}

function selectorText(selector?: any): string {
  if (!selector) return ''
  const parts: string[] = []
  for (const [k, v] of Object.entries(selector.matchLabels || {})) parts.push(`${k}=${v}`)
  for (const e of Array.isArray(selector.matchExpressions) ? selector.matchExpressions : []) {
    parts.push(`${e?.key} ${e?.operator} [${Array.isArray(e?.values) ? e.values.join(', ') : ''}]`)
  }
  return parts.join(', ')
}

function SelectorRow({ label, selector }: { label: string; selector?: any }) {
  const text = selectorText(selector)
  return <InfoRow label={label} value={text || '-'} />
}

function paramRefText(ref?: any): string {
  if (!ref) return '-'
  const name = ref.namespace ? `${ref.namespace}/${ref.name || ''}` : (ref.name || '')
  const sel = selectorText(ref.selector)
  const action = ref.parameterNotFoundAction ? ` (${ref.parameterNotFoundAction})` : ''
  return `${name || sel || '-'}${action}`
}

function ruleText(r: any): string {
  const groups = (Array.isArray(r?.apiGroups) ? r.apiGroups : []).map((g: string) => g || '""').join(',')
  const versions = (Array.isArray(r?.apiVersions) ? r.apiVersions : []).join(',')
  const resources = (Array.isArray(r?.resources) ? r.resources : []).join(',')
  const ops = (Array.isArray(r?.operations) ? r.operations : []).join(',')
  return `${groups}/${versions} ${resources} [${ops}]`
}

function RulesTable({ label, rules }: { label: string; rules: any[] }) {
  if (rules.length === 0) return <InfoRow label={label} value="-" />
  return (
    <div className="mt-2">
      <p className="text-[11px] font-medium text-slate-400 mb-1"><Tx>{label}</Tx></p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs border border-slate-700 rounded-sm">
          <thead>
            <tr className="bg-slate-800/60 text-slate-400">
              <Th className="text-left px-2 py-1.5">API Groups</Th>
              <Th className="text-left px-2 py-1.5">API Versions</Th>
              <Th className="text-left px-2 py-1.5">Operations</Th>
              <Th className="text-left px-2 py-1.5">Resources</Th>
              <Th className="text-left px-2 py-1.5">Resource Names</Th>
              <Th className="text-left px-2 py-1.5">Scope</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700">
            {rules.map((rule, idx) => (
              <tr key={idx} className="text-slate-200">
                <td className="px-2 py-1.5 wrap-break-word whitespace-pre-wrap">{Array.isArray(rule?.apiGroups) ? rule.apiGroups.map((g: string) => g || '""').join(', ') : '-'}</td>
                <td className="px-2 py-1.5 wrap-break-word whitespace-pre-wrap">{Array.isArray(rule?.apiVersions) ? rule.apiVersions.join(', ') : '-'}</td>
                <td className="px-2 py-1.5 wrap-break-word whitespace-pre-wrap">{Array.isArray(rule?.operations) ? rule.operations.join(', ') : '-'}</td>
                <td className="px-2 py-1.5 wrap-break-word whitespace-pre-wrap">{Array.isArray(rule?.resources) ? rule.resources.join(', ') : '-'}</td>
                <td className="px-2 py-1.5 wrap-break-word whitespace-pre-wrap">{Array.isArray(rule?.resourceNames) && rule.resourceNames.length > 0 ? rule.resourceNames.join(', ') : '-'}</td>
                <td className="px-2 py-1.5">{rule?.scope || '*'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
