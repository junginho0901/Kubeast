import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Database } from 'lucide-react'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import { useDashboardQueries } from '../hooks/useDashboardQueries'
import type { ResourceType } from '../types'
import { ResourceModal } from './ResourceModal'

// The window behind a Dashboard card whose list the cluster refused or the server failed drew "No services" and told the
// floating chat "0": it says the refusal or the failure where the rows would be, with no total or footer, and the chat
// is told the same with the reason. A list still loading tells nothing; one read empty is 0.

vi.mock('@/components/ModalOverlay', () => ({ ModalOverlay: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/components/ResourceDetailContext', () => ({ useResourceDetail: () => ({ open: () => {} }) }))
vi.mock('@/contexts/ClusterContext', () => ({ useCluster: () => ({ currentCluster: 'c1' }) }))
type Layer = { source?: string; summary?: string; data?: Record<string, any> }
const chat: { current: Layer | null } = { current: null }
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: (input: Layer | null) => { chat.current = input ?? null } }))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false },
  })
})
beforeEach(() => { chat.current = null })

const refused = { response: { status: 403, data: { detail: 'services is forbidden: User "kubeast:user:7" cannot list resource "services"' } }, message: 'Request failed with status code 403' }
const failed = { response: { status: 500, data: { detail: 'etcdserver: request timed out' } }, message: 'Request failed with status code 500' }

const window = (props: { isLoading?: boolean; listError?: unknown; resources?: unknown[]; lng?: string }) => {
  const resources = props.resources ?? []
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n: i18n.cloneInstance({ lng: props.lng ?? 'en' }) },
    createElement(ResourceModal, {
      selectedResourceType: 'services', onClose: () => {}, selectedStat: { name: 'Services', icon: Database },
      isLoading: props.isLoading ?? false, listError: props.listError, resourceCount: resources.length,
      searchQuery: '', setSearchQuery: () => {}, filteredResources: resources,
    })))
}

describe('the Services window of the Dashboard', () => {
  it('says the cluster refused the list, with no total, footer or "None", and tells the chat the refusal', () => {
    const html = window({ listError: refused })
    expect(html).toContain('data-testid="resource-modal-refused"')
    expect(html).toContain('You do not have permission to view Service in this cluster.')
    expect(html).not.toContain('No services')
    expect(html).not.toContain('data-testid="resource-modal-total"')
    expect(html).not.toContain('data-testid="resource-modal-pager"')
    expect(chat.current?.data).toEqual({ kind: 'Service', refused: refused.response.data.detail })
    expect(chat.current?.summary).toBe(`Services 목록 — 볼 권한 없음: ${refused.response.data.detail}`)
    expect(chat.current?.summary).not.toContain('0개')
  })

  it('says the list failed with the server\'s reason, and tells the chat the status and reason', () => {
    const html = window({ listError: failed })
    expect(html).toContain('data-testid="resource-modal-read-failed"')
    expect(html).toContain('Could not read the list: etcdserver: request timed out')
    expect(html).not.toContain('No services')
    expect(html).not.toContain('Total 0')
    expect(chat.current?.data).toEqual({ kind: 'Service', failed: { status: 500, reason: 'etcdserver: request timed out' } })
    expect(chat.current?.summary).toBe('Services 목록 — 불러오지 못함: etcdserver: request timed out')
  })

  it('says it in Korean on a Korean screen', () => {
    expect(window({ listError: refused, lng: 'ko' })).toContain('Service: 이 클러스터에서 볼 권한이 없습니다.')
    expect(window({ listError: failed, lng: 'ko' })).toContain('목록을 읽지 못했습니다: etcdserver: request timed out')
  })

  it('tells the chat nothing while the list loads', () => {
    window({ isLoading: true })
    expect(chat.current).toBeNull()
  })

  it('draws "None" and tells 0 only for a list read empty', () => {
    const html = window({})
    expect(html).toContain('No services')
    expect(html).toContain('Total 0')
    expect(chat.current?.summary).toBe('Services 목록 — 0개')
    expect(chat.current?.data).toEqual({ visible_items: [] })
  })

  it('lists the rows of a list that answered', () => {
    const html = window({ resources: [{ name: 'web', namespace: 'shop', type: 'ClusterIP', cluster_ip: '10.0.0.10' }] })
    expect(html).toContain('Total 1')
    expect(chat.current?.summary).toBe('Services 목록 — 1개')
    expect(chat.current?.data?.visible_items).toMatchObject([{ kind: 'Service', name: 'web', namespace: 'shop' }])
  })
})

describe('which window list the Dashboard says was not read', () => {
  const ERRORED: Record<ResourceType, unknown[]> = {
    namespaces: ['namespaces', 'c1'], pods: ['dashboard-pods-page', 'c1', '', null, 1], services: ['all-services', 'c1'],
    deployments: ['all-deployments', 'c1'], pvcs: ['all-pvcs', 'c1', 'plain'], nodes: ['modal-nodes', 'c1'],
  }
  const read = (type: ResourceType, seed: (qc: QueryClient) => void) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } } })
    seed(qc)
    const got: { errors?: Record<ResourceType, unknown> } = {}
    const Probe = () => {
      got.errors = useDashboardQueries({
        selectedResourceType: type, selectedPodStatus: null, isIssuesModalOpen: false, issuesWindowMinutes: null, includeRestartHistory: false,
        isStorageModalOpen: false, isOptimizationModalOpen: false, optimizationNamespace: '', storageActiveTab: 'pvcs', podQuery: { q: '', page: 1 },
      }).windowListErrors
      return null
    }
    renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(Probe)))
    return got.errors!
  }
  const fail = (qc: QueryClient, key: unknown[], error: unknown) => {
    const q = qc.getQueryCache().build(qc, { queryKey: key })
    q.setState({ ...q.state, status: 'error', error: error as Error, errorUpdatedAt: 1, errorUpdateCount: 1 })
  }

  it.each(Object.keys(ERRORED) as ResourceType[])('%s: the error of a read that did not answer', (type) => {
    expect(read(type, (qc) => fail(qc, ERRORED[type], refused))[type]).toBe(refused)
  })

  it('none for a list that answered, nor while it loads', () => {
    expect(read('services', (qc) => qc.setQueryData(ERRORED.services, []))).toMatchObject({ services: null })
    expect(read('services', () => {}).services).toBeNull()
  })
})
