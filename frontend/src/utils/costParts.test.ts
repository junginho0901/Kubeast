import { describe, expect, it } from 'vitest'

import { costOutsideCards, hasCostOutside } from './costParts'

describe('costOutsideCards', () => {
  it('is nothing without GPU and load balancer costs, whatever OpenCost rounded', () => {
    // argocd on the dev cluster: total 0.00896, the parts 0.00897 — five-decimal rounding, not another cost
    const o = costOutsideCards({ gpu_cost: 0, load_balancer_cost: 0 })
    expect(o).toEqual({ gpu: 0, loadBalancers: 0 })
    expect(hasCostOutside(o)).toBe(false)
  })

  it('names GPU and load balancers, which the cards do not show', () => {
    const o = costOutsideCards({ gpu_cost: 2, load_balancer_cost: 0.5 })
    expect(o).toEqual({ gpu: 2, loadBalancers: 0.5 })
    expect(hasCostOutside(o)).toBe(true)
    expect(hasCostOutside(costOutsideCards({ gpu_cost: 0, load_balancer_cost: 0.02 }))).toBe(true)
  })
})
