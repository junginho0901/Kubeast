import { describe, expect, it } from 'vitest'

import { isIssueStatus, kindWeight, pointsUp } from './constants'

// Every edge k8s-service draws (internal/k8s/resource_graph*.go), source → target.
const SERVER_EDGES: Array<[string, string]> = [
  ['Deployment', 'ReplicaSet'], ['StatefulSet', 'Pod'], ['DaemonSet', 'Pod'], ['ReplicaSet', 'Pod'],
  ['CronJob', 'Job'], ['Job', 'Pod'],
  ['Pod', 'ConfigMap'], ['Pod', 'Secret'], ['Pod', 'PersistentVolumeClaim'],
  ['Service', 'Pod'], ['Ingress', 'Service'], ['HorizontalPodAutoscaler', 'Deployment'],
  ['NetworkPolicy', 'Pod'], ['EndpointSlice', 'Service'],
  ['PersistentVolumeClaim', 'PersistentVolume'], ['StorageClass', 'PersistentVolume'],
  ['RoleBinding', 'Role'], ['RoleBinding', 'ServiceAccount'], ['ServiceAccount', 'Deployment'], ['ServiceAccount', 'DaemonSet'],
]

describe('resource graph rows', () => {
  it('lays every server edge down the rows once the upward ones are turned', () => {
    for (const [source, target] of SERVER_EDGES) {
      const [top, bottom] = pointsUp(source, target) ? [target, source] : [source, target]
      expect(kindWeight[top], `${source} → ${target}`).toBeGreaterThanOrEqual(kindWeight[bottom])
    }
  })

  it('turns only the edges whose source kind sits below the target', () => {
    expect(SERVER_EDGES.filter(([s, t]) => pointsUp(s, t))).toEqual([
      ['NetworkPolicy', 'Pod'],
      ['EndpointSlice', 'Service'],
      ['StorageClass', 'PersistentVolume'],
      ['RoleBinding', 'Role'],
      ['RoleBinding', 'ServiceAccount'],
      ['ServiceAccount', 'Deployment'],
      ['ServiceAccount', 'DaemonSet'],
    ])
  })

  it('puts a Service on the row of the workloads it selects for', () => {
    expect(kindWeight.Service).toBe(kindWeight.Deployment)
  })
})

// Every status the server gives a node (internal/k8s/resource_graph*.go): the Issues filter and the floating chat's
// problem count keep the same ones — a Service's type, a StorageClass's provisioner or "Active" is not a problem.
describe('resource graph issues', () => {
  it('counts as problems only the statuses the Issues filter keeps', () => {
    const issues = ['Pending', 'Failed', 'CrashLoopBackOff', 'ImagePullBackOff', 'Error', 'Terminating']
    const fine = ['Running', 'Succeeded', 'Active', 'Bound', 'ClusterIP', 'NodePort', 'LoadBalancer', 'ExternalName', 'rancher.io/local-path', 'Available', 'Progressing', 'Complete', '', undefined]
    expect(issues.filter((s) => !isIssueStatus(s))).toEqual([])
    expect(fine.filter((s) => isIssueStatus(s))).toEqual([])
  })
})
