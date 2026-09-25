import { describe, expect, it } from 'vitest'
import { hasPermission, matchAny, permMatches } from './permissions'

// Same table as services/pkg/auth permissions_test.go — the three matchers
// (Go, Python, TS) must agree on wildcard semantics.
describe('permMatches', () => {
  it.each([
    ['*', 'resource.pod.delete', true],
    ['resource.pod.read', 'resource.pod.read', true],
    ['resource.*.read', 'resource.pod.read', true],
    ['resource.*.create', 'resource.namespace.create', true],
    ['resource.*.read', 'resource.pod.logs', false],
    ['resource.*.read', 'resource.pod.read.extra', false],
    ['ai.tool.*', 'ai.tool.k8s_scale', true],
    ['ai.tool.*', 'ai.tool', false],
    ['menu.*', 'menu.workloads', true],
    ['resource.*', 'resource.pod.read', true],
    ['admin.users.read', 'admin.users.write', false],
  ])('%s vs %s → %s', (pattern, perm, want) => {
    expect(permMatches(pattern, perm)).toBe(want)
  })
})

describe('hasPermission', () => {
  const matrix = { '*': ['admin.users.read'], prod: ['resource.*.read'], alpha: ['resource.*.create', 'ai.tool.*'] }
  it('global entry applies to every cluster', () => {
    expect(hasPermission(matrix, 'admin.users.read', 'prod')).toBe(true)
  })
  it('cluster entries do not leak across clusters', () => {
    expect(hasPermission(matrix, 'resource.namespace.create', 'alpha')).toBe(true)
    expect(hasPermission(matrix, 'resource.namespace.create', 'prod')).toBe(false)
    expect(matchAny(undefined, 'resource.pod.read')).toBe(false)
  })
})
