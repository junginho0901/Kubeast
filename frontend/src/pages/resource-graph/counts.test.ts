import { describe, expect, it } from 'vitest'
import { graphTotals } from './counts'

// N3-b 9: the header counted the server's edges as they came, lines to objects without a box among them.
describe('graphTotals', () => {
  it('counts every box and only the lines between two boxes', () => {
    const graph = {
      nodes: [{ id: 'ReplicaSet/shop/web-1' }, { id: 'Pod/shop/web-1-a' }, { id: 'ConfigMap/shop/app' }],
      edges: [
        { source: 'ReplicaSet/shop/web-1', target: 'Pod/shop/web-1-a' },
        { source: 'Pod/shop/web-1-a', target: 'ConfigMap/shop/app' },
        // the ReplicaSet's owner is a Rollout, a kind the graph does not list
        { source: 'Rollout/shop/web', target: 'ReplicaSet/shop/web-1' },
      ],
    }
    expect(graphTotals(graph)).toEqual({ nodes: 3, edges: 2 })
  })

  it('is zero without a graph', () => {
    expect(graphTotals(undefined)).toEqual({ nodes: 0, edges: 0 })
  })
})
