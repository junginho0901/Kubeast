import { describe, expect, it } from 'vitest'

import { ruleApiGroupsText } from './ruleText'

// A PolicyRule's apiGroups as the Role, ClusterRole and ServiceAccount drawers write them: "" is the core group.
describe('ruleApiGroupsText', () => {
  it('writes the core group as ""', () => {
    expect(ruleApiGroupsText([''])).toBe('""')
  })

  it('writes the core group as "" beside a named group', () => {
    expect(ruleApiGroupsText(['', 'events.k8s.io'])).toBe('"", events.k8s.io')
  })

  it('writes named groups as they are', () => {
    expect(ruleApiGroupsText(['apps', 'batch'])).toBe('apps, batch')
    expect(ruleApiGroupsText(['*'])).toBe('*')
  })

  it('writes - for a rule that names no group, as a rule of URLs is', () => {
    expect(ruleApiGroupsText([])).toBe('-')
    expect(ruleApiGroupsText(undefined)).toBe('-')
  })
})
