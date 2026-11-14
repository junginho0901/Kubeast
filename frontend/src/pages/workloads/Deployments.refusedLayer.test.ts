import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import { recordForbidden, resetForbidden } from '@/services/forbiddenStore'
import { recordListStatus, resetListStatus } from '@/services/listStatusStore'
import Deployments from './Deployments'

// A list page whose list was refused or failed tells the floating chat no count: the screen shows no rows and says why,
// and its notices tell the chat the same. A list read empty is 0.

type Layer = { source?: string; summary: string; data?: Record<string, unknown> }
const told: Layer[] = []
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: (input: Layer | null | undefined) => { if (input) told.push(input) } }))
vi.mock('@/services/useKubeWatchList', () => ({ useKubeWatchList: () => {}, LIST_GATHER_MS: 100 }))
vi.mock('@/hooks/useCanCreate', () => ({ useWritesRefusedIn: () => () => false }))
vi.mock('@/hooks/usePermission', () => ({ usePermission: () => ({ has: () => false }) }))
vi.mock('@/components/ResourceDetailContext', () => ({ useResourceDetail: () => ({ open: () => {} }) }))
vi.mock('@/components/ResourceYamlCreateDialog', () => ({ default: () => null }))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => {
  told.length = 0
  resetForbidden()
  resetListStatus()
})

const KEY = ['workloads', 'deployments', 'all']

// The page as it stands once its list answered: rows, or the error its read ended with.
function open(answer: { rows: unknown[] } | { error: unknown }): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } } })
  client.setQueryData(['namespaces'], [])
  if ('rows' in answer) client.setQueryData(KEY, answer.rows)
  else client.getQueryCache().build(client, { queryKey: KEY }).setState({ status: 'error', error: answer.error, fetchStatus: 'idle', errorUpdatedAt: Date.now() })
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(I18nextProvider, { i18n }, createElement(QueryClientProvider, { client }, createElement(Deployments)))))
}

const baseLayers = () => told.filter((l) => (l.source ?? 'base') === 'base')

describe('a list page whose list was not read', () => {
  it('says no 0 to the floating chat when the list was refused', () => {
    recordForbidden('/cluster/deployments/all')
    const html = open({ error: { response: { status: 403, data: { detail: 'deployments.apps is forbidden' } }, message: 'Request failed with status code 403' } })
    expect(html).toContain('data-testid="table-forbidden"')
    expect(baseLayers()).toEqual([])
  })

  it('says no 0 when the list failed, and the empty row tells the chat why', () => {
    recordListStatus({ url: '/cluster/deployments/all', state: 'error', code: 500, reason: 'etcd timed out' })
    const html = open({ error: { response: { status: 500, data: { detail: 'etcd timed out' } }, message: 'Request failed with status code 500' } })
    expect(html).toContain('data-testid="table-load-error"')
    expect(baseLayers()).toEqual([])
    expect(told.find((l) => l.source === 'TableEmptyRow')?.data).toEqual({ notice: 'list_failed', list: 'Deployment', code: 500, reason: 'etcd timed out' })
  })

  it('says 0 for a list it read empty', () => {
    open({ rows: [] })
    const base = baseLayers().at(-1)
    expect(base?.data?.stats).toMatchObject({ total: 0 })
    expect(told.some((l) => l.source === 'TableEmptyRow')).toBe(false)
  })
})
