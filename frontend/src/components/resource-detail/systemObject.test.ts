import { describe, expect, it } from 'vitest'
import { systemObject } from './systemObject'

// Re-QA #38 (decision A): which deletes ask for the name, and which the API
// server refuses outright.
describe('systemObject', () => {
  it('blocks the namespaces the API server will not delete', () => {
    for (const ns of ['default', 'kube-system', 'kube-public']) {
      expect(systemObject('Namespace', null, ns)).toEqual({ blocked: true, reasons: ['immortalNamespace'] })
    }
    expect(systemObject('Namespace', null, 'kube-node-lease')).toEqual({ blocked: false, reasons: ['systemNamespace'] })
  })

  it('flags objects the cluster runs on', () => {
    expect(systemObject('DaemonSet', 'kube-system', 'kindnet').reasons).toEqual(['systemNamespace'])
    expect(systemObject('Node', null, 'worker-1').reasons).toEqual(['node'])
    expect(systemObject('CustomResourceDefinition', null, 'modelconfigs.ai.kubeast.io').reasons).toEqual(['crd'])
    expect(systemObject('ClusterRoleBinding', null, 'cluster-admin', { labels: { 'kubernetes.io/bootstrapping': 'rbac-defaults' } }).reasons)
      .toEqual(['bootstrap', 'systemRbac'])
    expect(systemObject('ClusterRole', null, 'system:node').reasons).toEqual(['systemRbac'])
    expect(systemObject('Deployment', 'kubeast', 'k8s-service', { annotations: { 'meta.helm.sh/release-name': 'kubeast' } }).reasons).toEqual(['helm'])
    expect(systemObject('ConfigMap', 'apps', 'web', { labels: { 'app.kubernetes.io/managed-by': 'Helm' } }).reasons).toEqual(['helm'])
  })

  it('leaves ordinary objects to the one-step delete', () => {
    expect(systemObject('ConfigMap', 'default', 'kube-root-ca.crt')).toEqual({ blocked: false, reasons: [] })
    expect(systemObject('Namespace', null, 'apps')).toEqual({ blocked: false, reasons: [] })
    expect(systemObject('ClusterRole', null, 'viewer-extra', { labels: null, annotations: null })).toEqual({ blocked: false, reasons: [] })
  })
})
