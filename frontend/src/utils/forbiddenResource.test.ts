import { describe, expect, it } from 'vitest'
import { forbiddenResourceFromUrl, joinResources } from './forbiddenResource'

describe('forbiddenResourceFromUrl', () => {
  // Re-QA #42: Kubernetes kind names, not lowercase plurals ("vertical pod autoscalers을(를)")
  it('names the kind for cluster-scoped and namespaced list paths', () => {
    expect(forbiddenResourceFromUrl('/cluster/roles/all?cluster=self')).toBe('Role')
    expect(forbiddenResourceFromUrl('/cluster/namespaces/web/rolebindings')).toBe('RoleBinding')
    expect(forbiddenResourceFromUrl('/cluster/vpas/all')).toBe('VerticalPodAutoscaler')
    expect(forbiddenResourceFromUrl('/cluster/httproutes/all')).toBe('HTTPRoute')
    expect(forbiddenResourceFromUrl('/cluster/ingressclasses')).toBe('IngressClass')
    expect(forbiddenResourceFromUrl('/cluster/namespaces/web/secrets/db/describe')).toBe('Secret')
    expect(forbiddenResourceFromUrl('/cluster/namespaces')).toBe('Namespace')
    expect(forbiddenResourceFromUrl('http://localhost:30080/api/v1/cluster/leases/all')).toBe('Lease')
  })

  it('names the grouped pages', () => {
    expect(forbiddenResourceFromUrl('/cluster/helm/releases?cluster=self')).toBe('Helm release')
    expect(forbiddenResourceFromUrl('/cluster/custom-resources/all')).toBe('custom resources')
    expect(forbiddenResourceFromUrl('/cluster/gateway-policies/all')).toBe('gateway policies')
  })

  it('falls back to the path segment', () => {
    expect(forbiddenResourceFromUrl('/cluster/somethingnew/all')).toBe('somethingnew')
  })

  it('joins unique names in a stable order', () => {
    expect(joinResources(['RoleBinding', 'Role', 'Role'])).toBe('Role, RoleBinding')
  })
})
