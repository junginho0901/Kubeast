import { describe, expect, it } from 'vitest'

import { RULE_TABLE_COLUMNS, ruleTableCells } from './ruleTable'
import { normalizeRules } from './useEffectivePermissions'

// A bound role's rules as the Effective Permissions table draws them from the drawer's describe answer: column → cell.
const table = (rules: unknown) => normalizeRules(rules).map((r) => {
  const cells = ruleTableCells(r)
  return Object.fromEntries(RULE_TABLE_COLUMNS.map((column, i) => [column, cells[i]]))
})

describe('the Effective Permissions rule table', () => {
  it('shows the URLs of a rule that names only non-resource URLs', () => {
    expect(table([{ nonResourceURLs: ['/healthz', '/version'], verbs: ['get'] }])).toEqual([
      { 'API Groups': '-', Resources: '-', 'Non-Resource URLs': '/healthz, /version', Verbs: 'get', 'Resource Names': '-' },
    ])
  })

  it('puts each rule of a role holding resource and URL rules in its own columns', () => {
    expect(table([
      { apiGroups: [''], resources: ['pods', 'pods/log'], verbs: ['get', 'list'] },
      { apiGroups: ['apps'], resources: ['deployments'], resourceNames: ['web'], verbs: ['patch'] },
      { nonResourceURLs: ['/metrics'], verbs: ['get'] },
    ])).toEqual([
      { 'API Groups': '""', Resources: 'pods, pods/log', 'Non-Resource URLs': '-', Verbs: 'get, list', 'Resource Names': '-' },
      { 'API Groups': 'apps', Resources: 'deployments', 'Non-Resource URLs': '-', Verbs: 'patch', 'Resource Names': 'web' },
      { 'API Groups': '-', Resources: '-', 'Non-Resource URLs': '/metrics', Verbs: 'get', 'Resource Names': '-' },
    ])
  })

  // The API server refuses such a rule; the table still drops neither side of it.
  it('keeps both sides of a rule that names resources and URLs', () => {
    expect(table([{ apiGroups: [''], resources: ['nodes'], nonResourceURLs: ['/logs/*'], verbs: ['get'] }])).toEqual([
      { 'API Groups': '""', Resources: 'nodes', 'Non-Resource URLs': '/logs/*', Verbs: 'get', 'Resource Names': '-' },
    ])
  })

  it('heads its columns as kubectl describe heads a PolicyRule, URLs after Resources, and fills every one', () => {
    expect(RULE_TABLE_COLUMNS).toEqual(['API Groups', 'Resources', 'Non-Resource URLs', 'Verbs', 'Resource Names'])
    for (const r of normalizeRules([{ verbs: ['get'] }, { nonResourceURLs: ['/x'], verbs: ['get'] }])) {
      expect(ruleTableCells(r)).toHaveLength(RULE_TABLE_COLUMNS.length)
    }
  })
})
