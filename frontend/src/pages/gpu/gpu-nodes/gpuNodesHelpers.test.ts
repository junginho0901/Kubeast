import { describe, expect, it } from 'vitest'

import type { GPUNodeInfo } from '@/services/api'
import { sortGPUNodes } from './gpuNodesHelpers'

const nodes = (...memory: (string | null | undefined)[]) =>
  memory.map((gpu_memory, i) => ({ name: `n${i}`, gpu_memory, gpu_capacity: i, gpu_allocatable: i, status: 'Ready', gpu_vendors: [] })) as unknown as GPUNodeInfo[]
const sorted = (dir: 'asc' | 'desc', ...memory: (string | null | undefined)[]) => sortGPUNodes(nodes(...memory), 'gpu_memory', dir).map((n) => n.gpu_memory ?? null)

// GPU memory is a number with its unit, not text: GPU Feature Discovery's label is mebibytes, with or without the unit the
// screen gives it, and AMD's node labeller writes gibibytes.
describe('sorting GPU Nodes by memory', () => {
  it('orders numbers by size, not by their first digit', () => {
    expect(sorted('asc', '23034', '8192', '100000', '16384')).toEqual(['8192', '16384', '23034', '100000'])
  })

  it('orders the same with the unit the screen gives mebibytes', () => {
    expect(sorted('asc', '23034 MiB', '8192 MiB', '100000 MiB', '16384 MiB')).toEqual(['8192 MiB', '16384 MiB', '23034 MiB', '100000 MiB'])
  })

  it('reads a unit, so another company\'s gibibytes fall among mebibytes by size', () => {
    expect(sorted('asc', '192G', '23034 MiB', '24GB', '8192 MiB', '16GiB', '100000 MiB')).toEqual(['8192 MiB', '16GiB', '23034 MiB', '24GB', '100000 MiB', '192G'])
  })

  it('reverses for descending', () => {
    expect(sorted('desc', '8192 MiB', '192G', '23034 MiB')).toEqual(['192G', '23034 MiB', '8192 MiB'])
  })

  it('puts a node without memory first going up and last going down, as an empty cell did', () => {
    expect(sorted('asc', '8192 MiB', null, '23034 MiB')).toEqual([null, '8192 MiB', '23034 MiB'])
    expect(sorted('desc', '8192 MiB', null, '23034 MiB')).toEqual(['23034 MiB', '8192 MiB', null])
  })

  it('reads a node with several companies\' GPUs by its largest', () => {
    expect(sorted('asc', '23034 MiB, 192G', '100000 MiB', '8192 MiB, 16G')).toEqual(['8192 MiB, 16G', '100000 MiB', '23034 MiB, 192G'])
  })

  it('leaves text with no size among the nodes without memory', () => {
    expect(sorted('asc', '8192 MiB', 'unknown')).toEqual(['unknown', '8192 MiB'])
  })

  it('still sorts the other columns as before', () => {
    const list = nodes('8192 MiB', '192G')
    expect(sortGPUNodes(list, null, 'asc')).toBe(list)
    expect(sortGPUNodes(list, 'gpu_capacity', 'desc').map((n) => n.name)).toEqual(['n1', 'n0'])
    expect(sortGPUNodes(list, 'name', 'desc').map((n) => n.name)).toEqual(['n1', 'n0'])
  })
})
