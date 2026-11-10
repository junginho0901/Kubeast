import { ruleApiGroupsText } from '../role-info/ruleText'
import type { RuleEntry } from './useEffectivePermissions'

// kubectl describe's PolicyRule columns, URLs right after Resources; API Groups stays its own column, as in the Role drawer.
export const RULE_TABLE_COLUMNS = ['API Groups', 'Resources', 'Non-Resource URLs', 'Verbs', 'Resource Names'] as const

export function ruleTableCells(r: RuleEntry): string[] {
  return [
    ruleApiGroupsText(r.apiGroups),
    r.resources.join(', ') || '-',
    r.nonResourceURLs.join(', ') || '-',
    r.verbs.join(', ') || '-',
    r.resourceNames?.join(', ') || '-',
  ]
}

// The API server reads a RoleBinding only for a request in its namespace, and a URL has none.
export function ruleRowNote(bindingKind: 'RoleBinding' | 'ClusterRoleBinding', r: RuleEntry): string | null {
  return bindingKind === 'RoleBinding' && r.nonResourceURLs.length > 0
    ? 'Not in effect through a RoleBinding; URLs need a ClusterRoleBinding.'
    : null
}
