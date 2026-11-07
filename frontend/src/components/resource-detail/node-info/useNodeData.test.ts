import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useNodeData } from './useNodeData'

const told = vi.fn()
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: (snapshot: unknown) => told(snapshot) }))
vi.mock('@/services/useKubeWatchList', () => ({ useKubeWatchList: () => {} }))
vi.mock('@/services/nodeShellSettings', () => ({ useNodeShellSettings: () => ({}) }))

const row = (name: string, status: string, phase = 'Running') => ({ name, namespace: 'ns', status, phase, ready: '0/1', restart_count: 0 })

// What the window tells the floating chat, given the pods its table holds.
function layerOf(pods: unknown[]) {
  told.mockClear()
  const client = new QueryClient()
  client.setQueryData(['cluster', 'nodes', 'pods', 'n1'], pods)
  const Window = () => {
    useNodeData('n1')
    return null
  }
  renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Window)))
  return told.mock.lastCall?.[0] as { data: Record<string, any> }
}

beforeEach(() => told.mockClear())

// The table shows ten pods a page, in the order they came: a crashing pod on a later page is still on this node.
describe('what a Node window tells the floating chat of its pods', () => {
  const healthy = Array.from({ length: 30 }, (_, i) => row(`fine-${String(i).padStart(2, '0')}`, 'Running'))

  it('names the pods that need a look, also those past the page on screen', () => {
    const { data } = layerOf([...healthy, row('crash', 'CrashLoopBackOff'), row('leaving', 'Terminating')])
    expect(data.pods_visible.map((p: { name: string }) => p.name)).toEqual(healthy.slice(0, 10).map((p) => p.name))
    expect(data.pods_not_running).toBe(2)
    expect(data.pods_not_running_list).toEqual([
      expect.objectContaining({ name: 'crash', namespace: 'ns', status: 'CrashLoopBackOff' }),
      expect.objectContaining({ name: 'leaving', namespace: 'ns', status: 'Terminating' }),
    ])
    expect(data.pods_not_running_list[0]._link).toContain('crash')
    expect(data.pods_not_running_cut).toBeUndefined()
  })

  it('says how many it left out when more need a look than it names', () => {
    const { data } = layerOf(Array.from({ length: 23 }, (_, i) => row(`bad-${i}`, 'Error', 'Failed')))
    expect(data.pods_not_running_list).toHaveLength(20)
    expect(data.pods_not_running_cut).toBe(3)
  })

  it('has no list when none does', () => {
    const { data } = layerOf(healthy)
    expect(data.pods_not_running).toBe(0)
    expect(data.pods_not_running_list).toBeUndefined()
  })
})
