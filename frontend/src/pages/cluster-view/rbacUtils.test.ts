import { describe, expect, it } from 'vitest'
import { rbacWatchPaths } from './rbacUtils'
import podRbacTabSrc from './PodRbacTab.tsx?raw'

const RBAC = '/apis/rbac.authorization.k8s.io/v1'

describe('what the pod RBAC tab follows', () => {
  it('the bindings of the pod\'s namespace and the cluster\'s, and the roles they name', () => {
    expect(rbacWatchPaths('shop', { role_bindings: [], cluster_role_bindings: [] })).toEqual([
      `${RBAC}/namespaces/shop/rolebindings`,
      `${RBAC}/namespaces/shop/roles`,
      `${RBAC}/clusterrolebindings`,
      `${RBAC}/clusterroles`,
    ])
  })

  // A reader limited to the namespace sees those named as refused: four more refusals would only add a notice to the page.
  it('leaves out what the answer says it could not read', () => {
    expect(rbacWatchPaths('shop', { role_bindings: [], cluster_role_bindings_error: 'forbidden' })).toEqual([
      `${RBAC}/namespaces/shop/rolebindings`,
      `${RBAC}/namespaces/shop/roles`,
    ])
    expect(rbacWatchPaths('shop', { role_bindings_error: 'forbidden', cluster_role_bindings_error: 'forbidden' })).toEqual([])
  })

  it('nothing before the first answer', () => {
    expect(rbacWatchPaths('shop', undefined)).toEqual([])
  })

  it('the tab reads its answer again on them', () => {
    expect(podRbacTabSrc).toContain('useWatchChanges({')
    expect(podRbacTabSrc).toContain("read: [['pod-rbac', pod.namespace, pod.name, includeAuthenticatedGroup]],")
  })
})
