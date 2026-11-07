import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import en from '../i18n/locales/en.json'
import ResourceGraph from './ResourceGraph'

// The floating chat is told what the page's notice says: a kind the user may not list is not a kind that has no objects.

type Layer = { summary?: string; data?: Record<string, unknown> }
const layers: Layer[] = []
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: (input: Layer | null) => { if (input) layers.push(input) } }))
vi.mock('@/hooks/usePrometheusQuery', () => ({ useClusterFeatures: () => ({ data: {} }) }))
vi.mock('@/hooks/usePermission', () => ({ usePermission: () => ({ has: () => false }) }))
vi.mock('@/contexts/ClusterContext', () => ({ useCluster: () => ({ currentCluster: 'self' }) }))
vi.mock('@/services/confirm', () => ({ useConfirm: () => async () => true }))
vi.mock('@/components/ResourceDetailContext', () => ({ useResourceDetail: () => ({ open: () => {}, target: null }) }))
vi.mock('@/components/resource-detail/NetworkPolicyCheckModal', () => ({ default: () => null }))
vi.mock('@xyflow/react', () => ({
  ReactFlow: () => null, Controls: () => null, Background: () => null, MiniMap: () => null, BackgroundVariant: { Dots: 'dots' },
  Handle: () => null, Position: {}, BaseEdge: () => null, EdgeLabelRenderer: () => null,
}))
vi.mock('./resource-graph/useResourceGraphLayout', () => ({
  useResourceGraphLayout: () => ({ nodes: [], edges: [], onNodesChange: () => {}, onEdgesChange: () => {}, layoutReady: true, selfLoops: [], routed: false, shown: { nodes: 1, edges: 0 } }),
}))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en', ns: ['translation'], defaultNS: 'translation',
    resources: { en: { translation: en } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => { layers.length = 0 })

function open(graph: unknown): Layer {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } } })
  client.setQueryData(['namespaces'], [{ name: 'default' }])
  client.setQueryData(['resource-graph', ['default'], true, 'none', []], graph)
  renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(QueryClientProvider, { client },
    createElement(MemoryRouter, null, createElement(ResourceGraph)))))
  return layers[layers.length - 1]
}

const node = { id: 'Pod/default/a', kind: 'Pod', name: 'a', namespace: 'default', status: 'Running', health: 'ok' }

describe('ResourceGraph floating chat layer', () => {
  it('names the kinds the cluster refuses the user, in its data and its summary', () => {
    const layer = open({ nodes: [node], edges: [], forbidden_kinds: ['Secret', 'Role'] })
    expect(layer.data?.forbidden_kinds).toEqual(['Secret', 'Role'])
    expect(layer.summary).toContain('Secret, Role')
  })

  it('says nothing about refused kinds when there are none', () => {
    const layer = open({ nodes: [node], edges: [] })
    expect(layer.data?.forbidden_kinds).toBeUndefined()
    expect(layer.summary).not.toContain('권한')
  })
})
