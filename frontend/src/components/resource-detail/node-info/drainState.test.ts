import { describe, expect, it } from 'vitest'
import { drainView } from './drainState'

describe('drainView', () => {
  it('keeps polling while the drain runs and shows its pods', () => {
    expect(drainView({ id: 'd', node: 'n1', status: 'pending' })).toEqual({ state: 'pending', ended: false, error: null, cordoned: null, pods: null })
    expect(drainView({ id: 'd', node: 'n1', status: 'draining', pods_total: 4, pods_done: 1 })).toEqual({
      state: 'draining', ended: false, error: null, cordoned: null, pods: { done: 1, total: 4 },
    })
  })

  it('reads an interrupted drain as ended, with the nodes the cluster still has cordoned', () => {
    expect(drainView({ id: 'd', node: 'n1', status: 'interrupted', message: 'the server running this drain stopped', cordoned_nodes: ['n1'] })).toEqual({
      state: 'interrupted', ended: true, error: null, cordoned: ['n1'], pods: null,
    })
    expect(drainView({ id: 'd', node: 'n1', status: 'interrupted', cordoned_nodes: [] }).cordoned).toEqual([])
  })

  it('says nothing of cordons the server did not read', () => {
    expect(drainView({ id: 'd', node: 'n1', status: 'interrupted' }).cordoned).toBeNull()
    expect(drainView({ id: 'd', node: 'n1', status: 'error', message: 'drain incomplete', cordoned_nodes: null }).cordoned).toBeNull()
  })

  it('keeps the reason of a failed drain and its cordoned nodes', () => {
    expect(drainView({ id: 'd', node: 'n1', status: 'error', message: 'drain incomplete: 1 of 3 pods', cordoned_nodes: ['n1'] })).toEqual({
      state: 'error', ended: true, error: 'drain incomplete: 1 of 3 pods', cordoned: ['n1'], pods: null,
    })
    expect(drainView({ id: 'd', node: 'n1', status: 'error' }).error).toBe('Failed')
  })

  it('reads a completed drain as ended with nothing more to say', () => {
    expect(drainView({ id: 'd', node: 'n1', status: 'success', cordoned_nodes: ['n1'] })).toEqual({
      state: 'success', ended: true, error: null, cordoned: null, pods: null,
    })
  })
})
