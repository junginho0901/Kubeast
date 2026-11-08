import { describe, expect, it } from 'vitest'
import { changesAllocated } from './nodePodsChange'
import useNodeDataSrc from './useNodeData.ts?raw'

const resources = (cpu: string) => [{ name: 'app', resources: { requests: { cpu } } }]
const pod = (name: string, phase: string, cpu = '100m', extra: object = {}) => ({ name, namespace: 'shop', phase, status: phase, containers: resources(cpu), ...extra })
const rows = [pod('a', 'Running'), pod('done', 'Succeeded')]

describe('changesAllocated', () => {
  it('a pod that arrives on the node counts, unless it has ended', () => {
    expect(changesAllocated(rows, { type: 'ADDED', object: pod('b', 'Pending') })).toBe(true)
    expect(changesAllocated(rows, { type: 'ADDED', object: pod('b', 'Succeeded') })).toBe(false)
  })

  it('a pod that leaves counts, unless it had ended', () => {
    expect(changesAllocated(rows, { type: 'DELETED', object: pod('a', 'Running') })).toBe(true)
    expect(changesAllocated(rows, { type: 'DELETED', object: pod('done', 'Succeeded') })).toBe(false)
  })

  it('a pod that ends counts, since kubectl adds up only the others', () => {
    expect(changesAllocated(rows, { type: 'MODIFIED', object: pod('a', 'Failed') })).toBe(true)
  })

  it('a pod resized in place counts', () => {
    expect(changesAllocated(rows, { type: 'MODIFIED', object: pod('a', 'Running', '200m') })).toBe(true)
  })

  it('a status that changes and nothing else does not: a crash loop would read the node\'s pods all the time', () => {
    expect(changesAllocated(rows, { type: 'MODIFIED', object: pod('a', 'Running', '100m', { status: 'CrashLoopBackOff', restart_count: 9 }) })).toBe(false)
  })

  it('what a watch opens with names the pods the rows have', () => {
    for (const row of rows) expect(changesAllocated(rows, { type: 'ADDED', object: row })).toBe(false)
  })

  it('a pod of the same name in another namespace is another pod', () => {
    expect(changesAllocated(rows, { type: 'ADDED', object: { ...pod('a', 'Running'), namespace: 'other' } })).toBe(true)
  })

  it('nothing before the rows have come', () => {
    expect(changesAllocated(undefined, { type: 'ADDED', object: pod('a', 'Running') })).toBe(false)
  })
})

describe('the Node drawer', () => {
  it('follows the node, the pods on it and their total', () => {
    expect(useNodeDataSrc).toContain('useDrawerFollowsObject({')
    expect(useNodeDataSrc).toContain('spec.nodeName=')
    expect(useNodeDataSrc).toContain('changesAllocated(')
  })
})
