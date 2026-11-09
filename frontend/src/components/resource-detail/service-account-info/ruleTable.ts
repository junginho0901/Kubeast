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
