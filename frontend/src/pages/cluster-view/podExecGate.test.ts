import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import type { NodeBoxRow } from '@/services/api'
import { getCurrentClusterID } from '@/services/clusterRef'
import { ClusterViewContext, type ClusterViewContextValue } from './ClusterViewContext'
import type { PodDetail } from './types'

// The pod window's Exec tab and the box menu's Exec, as ClusterViewBody wires them, ask what the Pods drawer asks
// (PodInfo): resource.pod.exec, which k8s-service's PodExecWS asks before the socket opens, and the cluster's answer for
// that pod's exec. The Write role holds resource.*.create and not resource.pod.exec, so its terminal is refused however
// the cluster answers (QA R3-007: the tab showed for Write and its click read "Connection error" with no reason).

const role = vi.hoisted(() => ({ perms: [] as string[] }))
vi.mock('@/hooks/usePermission', async () => {
  const { matchAny } = await import('@/utils/permissions')
  return { usePermission: () => ({ has: (p: string) => matchAny(role.perms, p) }) }
})
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: () => {} }))
vi.mock('@/components/ModalOverlay', () => ({ ModalOverlay: ({ children }: { children: ReactNode }) => children }))
// the parts of the page around the window and the menu
vi.mock('./hooks/useClusterPodsQuery', () => ({ useClusterPodsQuery: () => ({ namespaces: [], summary: undefined, nodes: [], isLoading: false }) }))
vi.mock('./hooks/usePodDetailQueries', () => ({
  usePodDetailQueries: () => ({ manifest: undefined, describeData: undefined, describeError: undefined, podRead: { data: undefined, dataAt: 0, error: null, errorAt: 0 } }),
}))
vi.mock('./hooks/useClusterAIContext', () => ({ useClusterAIContext: () => {} }))
vi.mock('./hooks/useClusterDerived', () => ({ useClusterDerived: () => [] }))
vi.mock('./hooks/useClusterEffects', () => ({ useClusterEffects: () => {} }))
vi.mock('./hooks/usePodDelete', () => ({ usePodDelete: () => ({ handleDeletePod: () => {} }) }))
vi.mock('./ClusterViewHeader', () => ({ ClusterViewHeader: () => null }))
vi.mock('./PodNodeGrid', () => ({ PodNodeGrid: () => null }))
vi.mock('./PodDeleteModal', () => ({ PodDeleteModal: () => null }))
vi.mock('./PodDetailTabBody', () => ({ PodDetailTabBody: () => null }))

import { ClusterViewBody } from './ClusterViewBody'

// The seeded roles (auth-service repository_schema.go SeedSystemRoles).
const WRITE = [
  'menu.*', 'resource.*.read', 'resource.*.create', 'resource.*.edit', 'resource.*.delete', 'resource.cronjob.suspend', 'resource.cronjob.trigger',
  'resource.secret.reveal', 'resource.alert.silence', 'resource.pod.logfile', 'resource.helm.read', 'resource.helm.rollback', 'resource.helm.upgrade',
  'resource.helm.test', 'ai.tool.*', 'ai.mcp.use',
]
const ADMIN = ['*']
// a custom role given the terminal on top of Write
const WRITE_AND_EXEC = [...WRITE, 'resource.pod.exec']

const container = { name: 'web', image: 'example.test/web:3', ready: true, state: { running: { started_at: '' } }, restart_count: 0 }
const windowPod = (namespace: string, name: string): PodDetail => ({
  name, namespace, node: 'n1', status: 'Running', phase: 'Running', restart_count: 0, created_at: '2026-11-21T00:00:00Z', containersKnown: true, containers: [container],
})
const menuPod = (namespace: string, name: string) => ({ name, namespace, node_name: 'n1', status: 'Running', phase: 'Running', restart_count: 0 }) as unknown as NodeBoxRow

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } })
})

const none = () => {}
function view(o: { pod?: PodDetail; menu?: NodeBoxRow }): ClusterViewContextValue {
  return {
    tr: (_key: string, fallback: string) => fallback,
    selectedNamespace: 'all', searchQuery: '',
    selectedPod: o.pod ?? null, activeTab: 'summary', selectedContainer: '', execContainer: '', showManifest: false, showDescribe: false,
    podContextMenu: o.menu ? { x: 10, y: 10, pod: o.menu } : null,
    deleteTargetPod: null, deleteForce: false, deleteError: null, isDeletingPod: false,
    setSelectedPod: none, setExecContainer: none, setSelectedContainer: none, setContainerSearchQuery: none, selectTab: none, setDeleteForce: none,
    closeContextMenu: none, openDeleteModal: none, closeDeleteModal: none, closeDetailModal: none,
  } as unknown as ClusterViewContextValue
}

// The page with the role's permissions and the cluster's answers for pods' exec (namespace/name → yes or no; a pod not
// named is still being asked).
function draw(perms: string[], answers: Record<string, boolean>, open: { pod?: PodDetail; menu?: NodeBoxRow }) {
  role.perms = perms
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } })
  for (const [pod, yes] of Object.entries(answers)) {
    const [namespace, name] = pod.split('/')
    qc.setQueryData(['can-i', getCurrentClusterID(), 'create', '', 'pods', namespace, name, 'exec'], yes)
  }
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n },
    createElement(QueryClientProvider, { client: qc },
      createElement(ClusterViewContext.Provider, { value: view(open) }, createElement(ClusterViewBody)))))
}

// each button drawn: its words, and whether it is an entry of the box menu
const buttons = (html: string) =>
  [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/g)].map(([, attrs, inner]) => ({ text: inner.replace(/<[^>]+>/g, ''), entry: attrs.includes('role="menuitem"') }))
const execTab = (html: string) => buttons(html).some((b) => !b.entry && b.text === 'Exec')
const execEntry = (html: string) => buttons(html).some((b) => b.entry && b.text === 'Exec')
const tabs = (html: string) => buttons(html).filter((b) => !b.entry && b.text !== '').map((b) => b.text)

describe("Cluster View's Exec tab and menu entry", () => {
  it('stay hidden for the Write role, though the cluster would let its group exec', () => {
    const html = draw(WRITE, { 'shop/web-1': true }, { pod: windowPod('shop', 'web-1'), menu: menuPod('shop', 'web-1') })
    expect(execTab(html)).toBe(false)
    expect(execEntry(html)).toBe(false)
    // the window and the menu are drawn, with the other tabs and Delete
    expect(tabs(html)).toEqual(['Summary', 'Logs', 'Describe', 'RBAC', 'Manifest'])
    expect(buttons(html).filter((b) => b.entry).map((b) => b.text)).toEqual(['Delete'])
  })

  it('show for a role holding resource.pod.exec where the cluster says yes for that pod', () => {
    for (const perms of [ADMIN, WRITE_AND_EXEC]) {
      const html = draw(perms, { 'shop/web-1': true }, { pod: windowPod('shop', 'web-1'), menu: menuPod('shop', 'web-1') })
      expect(tabs(html), perms.join(',')).toEqual(['Summary', 'Logs', 'Describe', 'RBAC', 'Manifest', 'Exec'])
      expect(execEntry(html), perms.join(',')).toBe(true)
    }
  })

  it("stay hidden where the cluster says no for the pod, as in a namespace the server guards, and while it is asked", () => {
    const refused = draw(ADMIN, { 'kubeast/frontend-1': false }, { pod: windowPod('kubeast', 'frontend-1'), menu: menuPod('kubeast', 'frontend-1') })
    expect(execTab(refused)).toBe(false)
    expect(execEntry(refused)).toBe(false)
    const asking = draw(ADMIN, {}, { pod: windowPod('shop', 'web-1'), menu: menuPod('shop', 'web-1') })
    expect(execTab(asking)).toBe(false)
    expect(execEntry(asking)).toBe(false)
  })

  it("ask for each one's own pod: the window's and the menu's", () => {
    const answers = { 'shop/web-1': true, 'kubeast/frontend-1': false }
    const html = draw(ADMIN, answers, { pod: windowPod('shop', 'web-1'), menu: menuPod('kubeast', 'frontend-1') })
    expect(execTab(html)).toBe(true)
    expect(execEntry(html)).toBe(false)
    const other = draw(ADMIN, answers, { pod: windowPod('kubeast', 'frontend-1'), menu: menuPod('shop', 'web-1') })
    expect(execTab(other)).toBe(false)
    expect(execEntry(other)).toBe(true)
  })
})
