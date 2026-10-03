import { describe, expect, it } from 'vitest'
import { forbiddenResourceFromUrl, joinResources } from './forbiddenResource'

describe('forbiddenResourceFromUrl', () => {
  it('names the kind for cluster-scoped and namespaced list paths', () => {
    expect(forbiddenResourceFromUrl('/cluster/roles/all?cluster=self')).toBe('roles')
    expect(forbiddenResourceFromUrl('/cluster/namespaces/web/rolebindings')).toBe('role bindings')
    expect(forbiddenResourceFromUrl('/cluster/vpas/all')).toBe('vertical pod autoscalers')
    expect(forbiddenResourceFromUrl('/cluster/ingressclasses')).toBe('ingress classes')
    expect(forbiddenResourceFromUrl('/cluster/namespaces/web/secrets/db/describe')).toBe('secrets')
    expect(forbiddenResourceFromUrl('/cluster/namespaces')).toBe('namespaces')
    expect(forbiddenResourceFromUrl('http://localhost:30080/api/v1/cluster/leases/all')).toBe('leases')
  })

  it('names the grouped pages', () => {
    expect(forbiddenResourceFromUrl('/cluster/helm/releases?cluster=self')).toBe('helm releases')
    expect(forbiddenResourceFromUrl('/cluster/custom-resources/all')).toBe('custom resources')
    expect(forbiddenResourceFromUrl('/cluster/gateway-policies/all')).toBe('gateway policies')
  })

  it('joins unique names in a stable order', () => {
    expect(joinResources(['rolebindings', 'roles', 'roles'])).toBe('rolebindings, roles')
  })
})
