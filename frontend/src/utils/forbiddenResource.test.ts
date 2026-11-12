import { describe, expect, it } from 'vitest'
import { forbiddenResourceFromUrl, isBuiltinApi, joinResources, listNamespaceFromUrl } from './forbiddenResource'

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

  it('names the admission policy kinds', () => {
    expect(forbiddenResourceFromUrl('/cluster/validatingadmissionpolicies?cluster=self')).toBe('ValidatingAdmissionPolicy')
    expect(forbiddenResourceFromUrl('/cluster/mutatingadmissionpolicies')).toBe('MutatingAdmissionPolicy')
  })

  it('falls back to the path segment', () => {
    expect(forbiddenResourceFromUrl('/cluster/somethingnew/all')).toBe('somethingnew')
  })

  it('joins unique names in a stable order', () => {
    expect(joinResources(['RoleBinding', 'Role', 'Role'])).toBe('Role, RoleBinding')
  })
})

// The lists ListIfServed answers "not installed" for: Kubernetes' own APIs (DRA, the admission policies) are not served
// rather than missing a CRD, the CRD-backed kinds keep the CRD text.
describe('isBuiltinApi', () => {
  it('is true for the built-in APIs a cluster may not serve, false for the CRD-backed kinds', () => {
    const builtin = ['deviceclasses', 'resourceclaims', 'resourceclaimtemplates', 'resourceslices', 'validatingadmissionpolicies', 'mutatingadmissionpolicies']
    const crd = ['vpas', 'gateways', 'gatewayclasses', 'httproutes', 'grpcroutes', 'referencegrants', 'backendtlspolicies', 'policyreports']
    expect(builtin.filter(isBuiltinApi)).toEqual(builtin)
    expect(crd.filter(isBuiltinApi)).toEqual([])
  })
})

describe('listNamespaceFromUrl', () => {
  it('reads the namespace of a namespaced path and none across the cluster', () => {
    expect(listNamespaceFromUrl('/cluster/namespaces/web/configmaps?cluster=self')).toBe('web')
    expect(listNamespaceFromUrl('/cluster/namespaces/web/secrets/db/describe')).toBe('web')
    expect(listNamespaceFromUrl('http://localhost:30080/api/v1/cluster/namespaces/web/pods')).toBe('web')
    expect(listNamespaceFromUrl('/cluster/configmaps/all')).toBeNull()
    expect(listNamespaceFromUrl('/cluster/namespaces')).toBeNull()
    expect(listNamespaceFromUrl('/cluster/namespaces/web')).toBeNull()
  })
})
