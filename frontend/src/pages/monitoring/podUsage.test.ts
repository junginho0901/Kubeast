import { describe, expect, it } from 'vitest'
import { podLimit, usageTone } from './podUsage'

describe('podLimit', () => {
  it('reads the limits under resources, as the pod list gives them', () => {
    expect(podLimit([{ resources: { limits: { memory: '170Mi' } } }], 'memory')).toBe(170 * 1024 ** 2)
    expect(podLimit([{ resources: { limits: { memory: '170Mi' } } }], 'cpu')).toBeNull()
  })

  it('adds the containers’ limits in their units', () => {
    expect(podLimit([{ limits: { cpu: '500m' } }, { limits: { cpu: '1.5' } }], 'cpu')).toBe(2000)
    expect(podLimit([{ limits: { memory: '256Mi' } }, { limits: { memory: '1Gi' } }], 'memory')).toBe(1280 * 1024 ** 2)
  })

  it('has none when any container sets none, or there are no containers', () => {
    expect(podLimit([{ limits: { cpu: '500m' } }, { limits: {} }], 'cpu')).toBeNull()
    expect(podLimit([{ limits: { cpu: '0' } }], 'cpu')).toBeNull()
    expect(podLimit([], 'memory')).toBeNull()
    expect(podLimit(undefined, 'memory')).toBeNull()
  })
})

describe('usageTone', () => {
  it('colours from 60% and 80% of the limit, and not without one', () => {
    expect(usageTone(null)).toBe('text-white')
    expect(usageTone(59.9)).toBe('text-white')
    expect(usageTone(60)).toBe('text-yellow-400')
    expect(usageTone(80)).toBe('text-red-400')
  })
})
