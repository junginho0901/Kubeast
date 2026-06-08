import { describe, it, expect } from 'vitest'
import { isClusterScopedQueryKey } from './clusterQueryScope'

describe('isClusterScopedQueryKey', () => {
  it('treats resource data keys as cluster-scoped (cleared on switch)', () => {
    expect(isClusterScopedQueryKey(['namespaces'])).toBe(true)
    expect(isClusterScopedQueryKey(['cluster', 'nodes'])).toBe(true)
    expect(isClusterScopedQueryKey(['workloads', 'pods', 'default'])).toBe(true)
    expect(isClusterScopedQueryKey(['network', 'services'])).toBe(true)
    expect(isClusterScopedQueryKey(['helm-releases'])).toBe(true)
    expect(isClusterScopedQueryKey(['pod-describe', 'ns', 'name'])).toBe(true)
  })

  it('keeps cluster-independent keys across a switch', () => {
    for (const head of [
      'me',
      'roles',
      'permissions',
      'organizations',
      'admin-users',
      'sessions',
      'session',
      'clusters',
      'cluster-roles',
      'setup',
      'setup-status',
      'deployment-mode',
      'ai-models',
      'audit-logs',
    ]) {
      expect(isClusterScopedQueryKey([head]), head).toBe(false)
    }
  })

  it('ignores non-array, empty, or non-string-head keys', () => {
    expect(isClusterScopedQueryKey('namespaces')).toBe(false)
    expect(isClusterScopedQueryKey([])).toBe(false)
    expect(isClusterScopedQueryKey([123])).toBe(false)
    expect(isClusterScopedQueryKey(undefined)).toBe(false)
    expect(isClusterScopedQueryKey(null)).toBe(false)
  })
})
