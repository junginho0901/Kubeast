import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import { recordForbidden, resetForbidden } from '@/services/forbiddenStore'
import { recordListStatus, resetListStatus } from '@/services/listStatusStore'
import { formatTime } from '@/utils/time'
import ForbiddenBanner from './ForbiddenBanner'
import { NOTICE_SOURCES, overlaysInOrder } from './PageContext'
import { RefreshFailure } from './RefreshFailure'
import { ResourceDetailContext, type ResourceDetailTarget } from './ResourceDetailContext'
import { TableEmptyRow } from './TableEmptyRow'
import { DescribeFailure, DescribeStale, ListReadFailure } from './resource-detail/DescribeFailure'

// A shared notice tells the floating chat what it says on screen: whenever the notice shows, its layer is there, in the
// notice's own words, with what it is about; when it does not show, it tells nothing.

type Layer = { source?: string; summary: string; data?: Record<string, unknown> }
const told: Layer[] = []
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: (input: Layer | null | undefined) => { if (input) told.push(input) } }))
vi.mock('react-router-dom', () => ({ useLocation: () => ({ pathname: '/workloads/deployments' }) }))
const access = vi.hoisted(() => ({ namespaces: null as string[] | null }))
vi.mock('@/hooks/usePermission', () => ({
  usePermission: () => ({ has: () => true, permissions: { '*': ['*'] }, clusterRole: 'admin', clusterNamespaces: access.namespaces }),
}))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false },
  })
})

const DRAWER: ResourceDetailTarget = { kind: 'HorizontalPodAutoscaler', name: 'web', namespace: 'shop' }

function render(element: ReactElement, lng = 'en', target: ResourceDetailTarget | null = DRAWER): string {
  told.length = 0
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: new QueryClient() },
      createElement(I18nextProvider, { i18n: i18n.cloneInstance({ lng }) },
        createElement(ResourceDetailContext.Provider, { value: { target, open: () => {}, close: () => {}, goBack: () => {}, canGoBack: false } },
          element))),
  )
}

// What a person reads: the markup's text, entities read back.
const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ')
const onlyLayer = (): Layer => {
  expect(told).toHaveLength(1)
  return told[0]
}
const row = (props: Parameters<typeof TableEmptyRow>[0]) => createElement('table', null, createElement('tbody', null, createElement(TableEmptyRow, props)))
const REFUSED = { response: { status: 403, data: { detail: 'horizontalpodautoscalers.autoscaling "web" is forbidden: User "u" cannot get resource' } }, message: 'Request failed with status code 403' }
const FAILED = { response: { status: 500, data: { detail: 'etcdserver: request timed out' } }, message: 'Request failed with status code 500' }

beforeEach(() => {
  resetForbidden()
  resetListStatus()
  access.namespaces = null
})

describe('ForbiddenBanner', () => {
  it('tells the chat the kinds the page was refused, in the banner\'s words', () => {
    recordForbidden('/cluster/deployments/all')
    recordForbidden('/cluster/namespaces')
    const html = render(createElement(ForbiddenBanner, { clusterKey: 'self' }))
    expect(html).toContain('data-testid="forbidden-banner"')
    const layer = onlyLayer()
    expect(layer.source).toBe('ForbiddenBanner')
    expect(layer.data).toEqual({ notice: 'forbidden', refused: ['Deployment', 'Namespace'] })
    const body = en.layout.forbidden.body.replace('{{resources}}', 'Deployment, Namespace')
    expect(textOf(html)).toContain(body)
    expect(layer.summary).toBe(`${en.layout.forbidden.title}: ${body}`)
  })

  it('says the namespaces a limited grant reads, as the banner does', () => {
    recordForbidden('/cluster/nodes')
    access.namespaces = ['team-a', 'team-b']
    const html = render(createElement(ForbiddenBanner, { clusterKey: 'self' }))
    const hint = en.layout.forbidden.namespaces.replace('{{namespaces}}', 'team-a, team-b')
    expect(textOf(html)).toContain(hint)
    const layer = onlyLayer()
    expect(layer.summary).toContain(hint)
    expect(layer.data).toMatchObject({ notice: 'forbidden', refused: ['Node'], access_limited_to_namespaces: ['team-a', 'team-b'] })
  })

  it('tells the chat in the screen\'s language', () => {
    recordForbidden('/cluster/deployments/all')
    render(createElement(ForbiddenBanner, { clusterKey: 'self' }), 'ko')
    expect(onlyLayer().summary).toContain(ko.layout.forbidden.body.replace('{{resources}}', 'Deployment'))
  })

  it('tells nothing when nothing was refused', () => {
    expect(render(createElement(ForbiddenBanner, { clusterKey: 'self' }))).toBe('')
    expect(told).toEqual([])
  })
})

describe('RefreshFailure', () => {
  it('tells the chat when the Refresh failed and why, in the line\'s words', () => {
    const failure = { at: '2026-11-15T03:59:18.000Z', reason: 'etcdserver: request timed out' }
    const html = render(createElement(RefreshFailure, { failure }))
    expect(html).toContain('data-testid="refresh-failed"')
    const layer = onlyLayer()
    expect(layer.source).toBe('RefreshFailure')
    expect(layer.data).toEqual({ notice: 'refresh_failed', failed_at: failure.at, reason: failure.reason })
    expect(layer.summary).toBe(en.common.refreshFailed.replace('{{time}}', formatTime(failure.at)).replace('{{reason}}', failure.reason))
    expect(textOf(html)).toContain(layer.summary)
  })

  it('tells nothing while the last Refresh worked', () => {
    render(createElement(RefreshFailure, { failure: null }))
    expect(told).toEqual([])
  })
})

describe('TableEmptyRow', () => {
  it('tells the chat a list the server failed, with its code and the server\'s reason', () => {
    recordListStatus({ url: '/cluster/deployments/all', state: 'error', code: 500, reason: 'list deployments: etcd timed out' })
    const html = render(row({ colSpan: 4, resource: 'deployments' }))
    expect(html).toContain('data-testid="table-load-error"')
    const layer = onlyLayer()
    expect(layer).toMatchObject({ source: 'TableEmptyRow', data: { notice: 'list_failed', list: 'Deployment', code: 500, reason: 'list deployments: etcd timed out' } })
    expect(layer.summary).toBe('Could not load Deployment (server error 500): list deployments: etcd timed out')
    expect(textOf(html)).toContain(layer.summary)
  })

  it('tells the chat a list that got no answer, without a code it did not get', () => {
    recordListStatus({ url: '/cluster/deployments/all', state: 'error' })
    const html = render(row({ colSpan: 4, resource: 'deployments' }))
    const layer = onlyLayer()
    expect(layer.data).toEqual({ notice: 'list_failed', list: 'Deployment', code: null })
    expect(textOf(html)).toContain(layer.summary)
  })

  it('tells the chat a list whose own read failed, with the reason the row gives', () => {
    const html = render(row({ colSpan: 4, resource: 'admin-roles', error: FAILED }))
    const layer = onlyLayer()
    expect(layer.data).toEqual({ notice: 'list_failed', list: 'admin-roles', reason: 'etcdserver: request timed out' })
    expect(textOf(html)).toContain(layer.summary)
  })

  it('tells the chat a kind the cluster has no CRD for, and a built-in API it does not serve, not an empty list', () => {
    recordListStatus({ url: '/cluster/vpas/all', state: 'notInstalled' })
    let html = render(row({ colSpan: 4, resource: 'vpas' }))
    expect(html).toContain('data-testid="table-not-installed"')
    let layer = onlyLayer()
    expect(layer.data).toEqual({ notice: 'not_installed', list: 'VerticalPodAutoscaler' })
    expect(textOf(html)).toContain(layer.summary)

    recordListStatus({ url: '/cluster/deviceclasses', state: 'notInstalled' })
    html = render(row({ colSpan: 4, resource: 'deviceclasses' }))
    layer = onlyLayer()
    expect(layer.data).toEqual({ notice: 'not_served', list: 'DeviceClass' })
    expect(textOf(html)).toContain(layer.summary)
  })

  it('leaves a refusal to the banner, and tells nothing for a list read empty', () => {
    recordForbidden('/cluster/deployments/all')
    expect(render(row({ colSpan: 4, resource: 'deployments' }))).toContain('data-testid="table-forbidden"')
    expect(told).toEqual([])
    resetForbidden()
    expect(render(row({ colSpan: 4, resource: 'deployments' }))).toContain(en.common.listEmpty)
    expect(told).toEqual([])
  })
})

describe('DescribeFailure', () => {
  it('tells the chat the drawer\'s object was not read, with the reason, about the object the drawer shows', () => {
    const html = render(createElement(DescribeFailure, { error: REFUSED }))
    expect(html).toContain('data-testid="describe-failed"')
    const layer = onlyLayer()
    expect(layer.source).toBe('DescribeFailure')
    expect(layer.data).toEqual({ notice: 'describe_failed', reason: REFUSED.response.data.detail, object: { kind: 'HorizontalPodAutoscaler', name: 'web', namespace: 'shop' } })
    expect(textOf(html)).toContain(layer.summary)
  })

  it('says that what still shows is the list\'s row, as the line does', () => {
    const html = render(createElement(DescribeFailure, { error: REFUSED, showingRow: true }))
    const layer = onlyLayer()
    expect(layer.data).toMatchObject({ notice: 'describe_failed', showing: 'list_row' })
    expect(textOf(html)).toContain(layer.summary)
  })

  it('names another object when the line is about it (a VPA\'s target, the Cluster View pod)', () => {
    render(createElement(DescribeFailure, { error: FAILED, about: { kind: 'Pod', name: 'api-0', namespace: 'shop' } }), 'en', null)
    expect(onlyLayer().data).toMatchObject({ object: { kind: 'Pod', name: 'api-0', namespace: 'shop' } })
  })

  it('tells nothing without an error', () => {
    expect(render(createElement(DescribeFailure, { error: null }))).toBe('')
    expect(told).toEqual([])
  })
})

describe('DescribeStale', () => {
  it('tells the chat that what the drawer shows was read earlier, when, and why it was not read again', () => {
    const readAt = Date.parse('2026-11-15T03:50:00Z')
    const html = render(createElement(DescribeStale, { error: FAILED, readAt }))
    expect(html).toContain('data-testid="describe-stale"')
    const layer = onlyLayer()
    expect(layer.source).toBe('DescribeStale')
    expect(layer.data).toEqual({
      notice: 'stale',
      read_at: '2026-11-15T03:50:00.000Z',
      reason: 'etcdserver: request timed out',
      object: { kind: 'HorizontalPodAutoscaler', name: 'web', namespace: 'shop' },
    })
    expect(layer.summary).toContain(formatTime(readAt))
    expect(textOf(html)).toContain(layer.summary)
  })

  it('tells nothing while the reads work', () => {
    expect(render(createElement(DescribeStale, { error: null, readAt: Date.now() }))).toBe('')
    expect(told).toEqual([])
  })
})

describe('ListReadFailure', () => {
  it('tells the chat the list beside the object that failed, by the section\'s name, with the reason', () => {
    const html = render(createElement(ListReadFailure, { error: REFUSED, list: 'Pods' }), 'en', { kind: 'Namespace', name: 'shop' })
    expect(html).toContain('data-testid="list-read-failed"')
    const layer = onlyLayer()
    expect(layer.source).toBe('ListReadFailure')
    expect(layer.data).toEqual({ notice: 'beside_list_failed', list: 'Pods', reason: REFUSED.response.data.detail, object: { kind: 'Namespace', name: 'shop' } })
    expect(textOf(html)).toContain(layer.summary)
  })

  it('tells nothing while the list reads', () => {
    expect(render(createElement(ListReadFailure, { error: null, list: 'Pods' }))).toBe('')
    expect(told).toEqual([])
  })
})

describe('the notices among the windows the floating chat is told of', () => {
  it('are never the window on top, so the drawer stays the one "this" points at', () => {
    for (const source of NOTICE_SOURCES) {
      const ordered = overlaysInOrder([{ source: 'ResourceDetailDrawer', summary: 'd' }, { source: 'HorizontalPodAutoscalerInfo', summary: 'o' }, { source, summary: 'n' }])
      expect(ordered.map((l) => l.source), source).toEqual([source, 'ResourceDetailDrawer', 'HorizontalPodAutoscalerInfo'])
    }
  })

  it('cover every shared notice', () => {
    expect([...NOTICE_SOURCES].sort()).toEqual(['DescribeFailure', 'DescribeStale', 'ForbiddenBanner', 'ListReadFailure', 'MetricsNotRead', 'RefreshFailure', 'TableEmptyRow', 'WatchProblemNotice'])
  })
})
