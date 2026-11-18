import { describe, expect, it } from 'vitest'
import { paramsForCluster } from './clusterScopedParams'

// A cluster switch on Cluster View's node view: the node, its page and the pod a search opened belong to the cluster
// before, so the address of the new one leaves them out; the namespace and anything else stay.

describe('paramsForCluster', () => {
  const on = (q: string) => new URLSearchParams(q)
  it('drops the node view of the cluster before on a switch', () => {
    expect(paramsForCluster(on('cluster=a&namespace=x&node=ip-1&nodePage=2&pod=x%2Fweb'), 'b', 'a').toString()).toBe('cluster=b&namespace=x')
  })
  it('keeps it when the cluster stays, and on the first selection after sign-in', () => {
    expect(paramsForCluster(on('cluster=a&node=ip-1&nodePage=2'), 'a', 'a').toString()).toBe('cluster=a&node=ip-1&nodePage=2')
    expect(paramsForCluster(on('node=ip-1'), 'a', '').toString()).toBe('node=ip-1&cluster=a')
  })
  it('clears the cluster when none is chosen', () => {
    expect(paramsForCluster(on('cluster=a&node=ip-1'), '', 'a').toString()).toBe('')
  })
})
