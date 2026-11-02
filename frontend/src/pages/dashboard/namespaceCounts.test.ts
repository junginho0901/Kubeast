import { describe, expect, it } from 'vitest'

import { namespaceCounts } from './namespaceCounts'

describe('namespaceCounts', () => {
  it('counts each namespace from the lists, 0 where a list has none of it', () => {
    const c = namespaceCounts(
      ['a', 'b', 'c'],
      [{ name: 'a', count: 3 }, { name: 'b', count: 1 }],
      [{ namespace: 'a' }, { namespace: 'a' }, { namespace: 'c' }],
      [{ namespace: 'b' }],
    )
    expect(c).toEqual({
      a: { pods: 3, services: 2, deployments: 0 },
      b: { pods: 1, services: 0, deployments: 1 },
      c: { pods: 0, services: 1, deployments: 0 },
    })
  })

  it('has no count for a list that failed or has not come, nor for a namespace folded into "(other)"', () => {
    const c = namespaceCounts(['a', 'z'], [{ name: 'a', count: 2 }, { name: '(other)', count: 9 }], undefined, [])
    expect(c.a).toEqual({ pods: 2, services: undefined, deployments: 0 })
    expect(c.z).toEqual({ pods: undefined, services: undefined, deployments: 0 })
  })
})
