import { describe, expect, it } from 'vitest'
import { parseNamespaceList, sameNamespaces } from './namespaceScope'
import { scopedPaths } from '@/services/useKubeWatchList'

describe('namespace scope', () => {
  it('parses a typed list: separators, case, duplicates, order', () => {
    expect(parseNamespaceList(' Web, api  web\napi,')).toEqual(['api', 'web'])
    expect(parseNamespaceList('')).toEqual([])
    expect(sameNamespaces(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(sameNamespaces(undefined, [])).toBe(true)
    expect(sameNamespaces(['a'], ['a', 'b'])).toBe(false)
  })

  it('rewrites an all-namespaces watch path per granted namespace', () => {
    expect(scopedPaths('/api/v1/pods', ['api', 'web'])).toEqual(['/api/v1/namespaces/api/pods', '/api/v1/namespaces/web/pods'])
    expect(scopedPaths('/apis/apps/v1/deployments', ['web'])).toEqual(['/apis/apps/v1/namespaces/web/deployments'])
    // Already namespaced, or no scope: untouched.
    expect(scopedPaths('/api/v1/namespaces/web/pods', ['api'])).toEqual(['/api/v1/namespaces/web/pods'])
    expect(scopedPaths('/api/v1/pods', undefined)).toEqual(['/api/v1/pods'])
    expect(scopedPaths('/api/v1/pods', [])).toEqual(['/api/v1/pods'])
  })

  it('leaves a kind of no namespace whole: one watch, which the server answers by the cluster\'s RBAC', () => {
    for (const path of [
      '/api/v1/nodes',
      '/api/v1/namespaces',
      '/api/v1/persistentvolumes',
      '/apis/storage.k8s.io/v1/storageclasses',
      '/apis/storage.k8s.io/v1/volumeattachments',
      '/apis/networking.k8s.io/v1/ingressclasses',
      '/apis/rbac.authorization.k8s.io/v1/clusterroles',
      '/apis/rbac.authorization.k8s.io/v1/clusterrolebindings',
      '/apis/scheduling.k8s.io/v1/priorityclasses',
      '/apis/node.k8s.io/v1/runtimeclasses',
      '/apis/admissionregistration.k8s.io/v1/validatingwebhookconfigurations',
      '/apis/admissionregistration.k8s.io/v1/mutatingwebhookconfigurations',
      '/apis/apiextensions.k8s.io/v1/customresourcedefinitions',
      '/apis/gateway.networking.k8s.io/v1/gatewayclasses',
      '/apis/resource.k8s.io/v1/deviceclasses',
      '/apis/resource.k8s.io/v1/resourceslices',
    ]) {
      expect(scopedPaths(path, ['api', 'web'])).toEqual([path])
    }
  })
})
