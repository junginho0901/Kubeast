import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeAll, describe, expect, it } from 'vitest'
import en from '../../i18n/locales/en.json'
import ko from '../../i18n/locales/ko.json'
import { EventsSection } from './DetailCommon'
import { eventsForAI, eventsNewestFirst } from './detailFormat'
import IngressClassDetail from './network-info/IngressClassDetail'
import EndpointDetail from './network-info/EndpointDetail'
import IngressDetail from './network-info/IngressDetail'
import NetworkPolicyDetail from './network-info/NetworkPolicyDetail'
import EndpointSliceDetail from './network-info/EndpointSliceDetail'
import DeviceClassInfo from './DeviceClassInfo'
import ResourceClaimInfo from './ResourceClaimInfo'
import ResourceClaimTemplateInfo from './ResourceClaimTemplateInfo'
import ResourceSliceInfo from './ResourceSliceInfo'
import GenericInfo from './GenericInfo'
import { PageContextCtx, type PageContextValue } from '@/components/PageContext'
import { PodDescribeTab } from '@/pages/cluster-view/PodDescribeTab'
import { applyNetworkPolicyToDrawer } from '@/pages/network/networkpolicies/networkPolicyWatchNormalize'

// Every drawer draws its Events section: the events, "None" without any, and that they could not be read (with the
// server's reason) instead of a "None" nobody read.

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    ns: ['translation', 'detail'],
    defaultNS: 'translation',
    resources: { en: { translation: en, detail: {} }, ko: { translation: ko, detail: (ko as { detail: Record<string, string> }).detail } },
    interpolation: { escapeValue: false },
  })
})

const render = (lng: string, el: ReactElement, seed: [unknown[], unknown][] = []) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  for (const [key, data] of seed) qc.setQueryData(key, data)
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n: i18n.cloneInstance({ lng }) },
    createElement(QueryClientProvider, { client: qc }, el)))
}
// the Events section of a drawer: its title, then its body up to the next section
const eventsPart = (html: string, title = 'Events') => {
  const at = html.indexOf(`>${title}</p>`)
  if (at < 0) return 'no Events section'
  const next = html.indexOf('<div class="rounded-lg border', at)
  return html.slice(at, next < 0 ? undefined : next)
}
const rows = (part: string) => (part.split('<tbody')[1] ?? '').match(/<tr\b/g)?.length ?? 0
const ev = (i: number) => ({ type: 'Normal', reason: `Seen${i}`, message: `event ${i}`, count: 1 })
const REFUSED = 'events is forbidden: User "u" cannot list resource "events" in API group "" in the namespace "ns"'

describe('EventsSection', () => {
  it('lists the events, ten to a page', () => {
    const part = eventsPart(render('en', createElement(EventsSection, { events: Array.from({ length: 12 }, (_, i) => ev(i)) })))
    expect(rows(part)).toBe(10)
    expect(part).toContain('1-10 / 12')
    expect(part).not.toContain('None')
  })

  it('says "None" when the events were read and there are none', () => {
    const part = eventsPart(render('en', createElement(EventsSection, { events: [] })))
    expect(part).toContain('>None</span>')
    expect(rows(part)).toBe(0)
  })

  it('says the events could not be read, with the reason, instead of "None"', () => {
    const part = eventsPart(render('en', createElement(EventsSection, { events: undefined, error: REFUSED })))
    expect(part).toContain(`Could not load the events: ${REFUSED.replace(/"/g, '&quot;')}`)
    expect(part).not.toContain('None')
  })

  it('says the events could not be read when the answer has neither the events nor a reason', () => {
    const part = eventsPart(render('en', createElement(EventsSection, { events: undefined })))
    expect(part).toContain('Could not load the events.')
    expect(part).not.toContain('None')
  })

  it('says "Loading..." until the answer comes, not "None"', () => {
    const part = eventsPart(render('en', createElement(EventsSection, { events: undefined, loading: true })))
    expect(part).toContain('Loading...')
    expect(part).not.toContain('None')
  })

  it('in Korean: the section title, "없음" and the reason line from the detail catalog', () => {
    expect(eventsPart(render('ko', createElement(EventsSection, { events: [] })), '이벤트')).toContain('>없음</span>')
    expect(eventsPart(render('ko', createElement(EventsSection, { events: undefined, error: 'x' })), '이벤트')).toContain('이벤트를 불러오지 못했습니다: x')
    expect(eventsPart(render('ko', createElement(EventsSection, { events: undefined })), '이벤트')).toContain('이벤트를 불러오지 못했습니다.')
  })
})

describe('eventsNewestFirst (the Node and Namespace drawers)', () => {
  it('sorts by the last time, and keeps an answer without a list unread rather than empty', () => {
    const got = eventsNewestFirst([{ reason: 'Old', last_timestamp: '2026-11-04T00:00:00Z' }, { reason: 'New', last_timestamp: '2026-11-04T01:00:00Z' }, { reason: 'First', first_timestamp: '2026-11-04T00:30:00Z' }])
    expect(got?.map((e) => e.reason)).toEqual(['New', 'First', 'Old'])
    expect(eventsNewestFirst([])).toEqual([])
    expect(eventsNewestFirst(undefined)).toBeUndefined()
  })
})

describe('drawers draw the Events section with or without events', () => {
  const ic = (describe: unknown) => render('en', createElement(IngressClassDetail, { name: 'nginx', rawJson: { metadata: { name: 'nginx' } } }),
    [[['ingressclass-describe', 'nginx'], describe], [['ingressclass-used-by', 'nginx'], []]])
  const ep = (describe: unknown) => render('en', createElement(EndpointDetail, { name: 'web', namespace: 'ns', kind: 'Endpoints' }),
    [[['endpoints-describe', 'ns', 'web'], describe]])

  it('IngressClass: "None" without events, the table with them, the reason when refused', () => {
    expect(eventsPart(ic({ name: 'nginx', events: [] }))).toContain('>None</span>')
    expect(rows(eventsPart(ic({ name: 'nginx', events: [ev(1), ev(2)] })))).toBe(2)
    expect(eventsPart(ic({ name: 'nginx', events_error: REFUSED }))).toContain('Could not load the events: events is forbidden')
  })

  it('Endpoints: "None" without events, the reason when refused', () => {
    expect(eventsPart(ep({ name: 'web', ready_count: 0, not_ready_count: 0, events: [] }))).toContain('>None</span>')
    expect(eventsPart(ep({ name: 'web', ready_count: 0, not_ready_count: 0, events_error: REFUSED }))).toContain('Could not load the events: events is forbidden')
  })

  it('the Cluster View pod window\'s Describe tab: "None", or the reason', () => {
    const tr = (key: string, fallback: string, o?: Record<string, unknown>) => i18n.t(key, { defaultValue: fallback, ...o })
    const tab = (data: Record<string, unknown>) => renderToStaticMarkup(createElement(PodDescribeTab, { data: { name: 'p', namespace: 'ns', ...data }, na: '-', tr }))
    const events = (html: string) => html.slice(html.indexOf('>Events</h3>'))
    expect(events(tab({ events: [] }))).toContain('>None</p>')
    expect(events(tab({ events_error: REFUSED }))).toContain('Could not load the events: events is forbidden')
    expect(events(tab({}))).toContain('Could not load the events.')
  })

  it('the Cluster View pod window\'s Describe tab: Labels, Containers and Conditions say "None" as Events does', () => {
    const tr = (key: string, fallback: string, o?: Record<string, unknown>) => i18n.t(key, { defaultValue: fallback, ...o })
    const tab = (data: Record<string, unknown>) => renderToStaticMarkup(createElement(PodDescribeTab, { data: { name: 'p', namespace: 'ns', events: [], ...data }, na: '-', tr }))
    const part = (html: string, title: string) => {
      const at = html.indexOf(`>${title}</h3>`)
      if (at < 0) return `no ${title} section`
      const next = html.indexOf('<h3', at)
      return html.slice(at, next < 0 ? undefined : next)
    }
    for (const empty of [{}, { labels: {}, containers: [], conditions: [] }, { labels: null, containers: null, conditions: null }]) {
      const html = tab(empty)
      for (const title of ['Labels', 'Containers', 'Conditions']) expect(part(html, title), title).toContain('>None</p>')
    }
    const filled = tab({ labels: { app: 'web' }, containers: [{ name: 'c1', image: 'i', ready: true, restart_count: 0 }], conditions: [{ type: 'Ready', status: 'True' }] })
    expect(part(filled, 'Labels')).toContain('app:')
    expect(part(filled, 'Containers')).toContain('c1')
    expect(part(filled, 'Conditions')).toContain('Ready')
    for (const title of ['Labels', 'Containers', 'Conditions']) expect(part(filled, title), title).not.toContain('>None</p>')
  })
})

// The drawers that had no Events section: what kubectl describe's Events shows, "None" without any, the reason when the
// cluster refused, each from the describe answer the drawer reads.
describe('the drawers that gained the Events section', () => {
  const PAGE = { registerLayer: () => {}, unregisterLayer: () => {}, getSnapshot: () => ({}), consumeContextChanged: () => false } as unknown as PageContextValue
  const inPage = (el: ReactElement) => createElement(PageContextCtx.Provider, { value: PAGE }, el)
  const cases: { kind: string; el: ReactElement; key: unknown[] }[] = [
    { kind: 'Ingress', el: inPage(createElement(IngressDetail, { name: 'x', namespace: 'ns', rawJson: { metadata: { name: 'x' } } })), key: ['ingress-describe', 'ns', 'x'] },
    { kind: 'NetworkPolicy', el: inPage(createElement(NetworkPolicyDetail, { name: 'x', namespace: 'ns', rawJson: { metadata: { name: 'x' }, spec: {} } })), key: ['networkpolicy-describe', 'ns', 'x'] },
    { kind: 'EndpointSlice', el: inPage(createElement(EndpointSliceDetail, { name: 'x', namespace: 'ns', rawJson: { metadata: { name: 'x' } } })), key: ['endpointslice-describe', 'ns', 'x'] },
    { kind: 'DeviceClass', el: inPage(createElement(DeviceClassInfo, { name: 'x' })), key: ['deviceclass-describe', 'x'] },
    { kind: 'ResourceClaim', el: inPage(createElement(ResourceClaimInfo, { name: 'x', namespace: 'ns' })), key: ['resourceclaim-describe', 'ns', 'x'] },
    { kind: 'ResourceClaimTemplate', el: inPage(createElement(ResourceClaimTemplateInfo, { name: 'x', namespace: 'ns' })), key: ['resourceclaimtemplate-describe', 'ns', 'x'] },
    { kind: 'ResourceSlice', el: inPage(createElement(ResourceSliceInfo, { name: 'x' })), key: ['resourceslice-describe', 'x'] },
    { kind: 'a kind with no view of its own', el: inPage(createElement(GenericInfo, { name: 'x', namespace: 'ns', kind: 'Gadget', rawJson: { apiVersion: 'example.com/v1', metadata: { name: 'x' } } })), key: ['generic-describe', 'Gadget', 'ns', 'x', 'example.com'] },
  ]
  for (const c of cases) {
    it(`${c.kind}: the events, "None" without any, the reason when refused`, () => {
      const drawn = (describe: unknown) => eventsPart(render('en', c.el, [[c.key, describe]]))
      expect(rows(drawn({ name: 'x', events: [ev(1), ev(2)] }))).toBe(2)
      expect(drawn({ name: 'x', events: [] })).toContain('>None</span>')
      expect(drawn({ name: 'x', events_error: REFUSED })).toContain('Could not load the events: events is forbidden')
    })
  }

  it('the AI layer gets what the section shows: the list, or why it was not read', () => {
    expect(eventsForAI({ events: [ev(1)] })).toEqual({ events: [ev(1)] })
    expect(eventsForAI({ events: [] })).toEqual({ events: [] })
    expect(eventsForAI({ events_error: REFUSED })).toEqual({ events_error: REFUSED })
    expect(eventsForAI(undefined)).toEqual({})
  })
})

// A NetworkPolicy drawer follows the object live; a live update of the policy keeps the events the describe answered.
describe('a NetworkPolicy drawer following its object', () => {
  it('keeps the events through a live update', () => {
    const prev = { name: 'x', namespace: 'ns', events: [ev(1)], pod_selector: { match_labels: {}, match_expressions: [] }, policy_types: [] }
    const next = applyNetworkPolicyToDrawer(prev as never, { type: 'MODIFIED', object: { name: 'x', namespace: 'ns', pod_selector: { match_labels: { a: 'b' }, match_expressions: [] }, policy_types: ['Ingress'] } } as never, 'x') as unknown as Record<string, unknown>
    expect(next.events).toEqual([ev(1)])
    expect(next.policy_types).toEqual(['Ingress'])
    const refused = applyNetworkPolicyToDrawer({ ...prev, events: undefined, events_error: REFUSED } as never, { type: 'MODIFIED', object: { name: 'x', namespace: 'ns', pod_selector: { match_labels: {}, match_expressions: [] }, policy_types: [] } } as never, 'x') as unknown as Record<string, unknown>
    expect(refused.events_error).toBe(REFUSED)
  })
})

// Every drawer component draws its Events section through EventsSection: none hides it when the list is empty
// (`events.length > 0 &&`) or draws EventsTable itself, which cannot tell "none" from "not read".
describe('the drawers', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url))
  const files: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name))
      else if (/\.tsx$/.test(e.name)) files.push(join(d, e.name))
    }
  }
  walk(dir)

  it('draw Events only through EventsSection', () => {
    const bad = files.filter((f) => !f.endsWith('DetailCommon.tsx'))
      .flatMap((f) => {
        const src = readFileSync(f, 'utf8')
        return [/events\??\.length\s*>\s*0\s*&&/, /<EventsTable\b/, /title="Events"/].filter((re) => re.test(src)).map((re) => `${relative(dir, f)}: ${re}`)
      })
    expect(bad).toEqual([])
  })

  it('so every drawer that reads events has the section (44 drawers)', () => {
    const using = files.filter((f) => /<EventsSection\b/.test(readFileSync(f, 'utf8'))).map((f) => relative(dir, f)).sort()
    expect(using.length).toBe(44)
  })
})
