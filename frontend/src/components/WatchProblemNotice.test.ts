import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import { recordWatchFrame, resetWatchProblems } from '@/services/watchProblemStore'
import { overlaysInOrder } from './PageContext'
import WatchProblemNotice from './WatchProblemNotice'

// What a list that stopped following says, above the page and to the floating chat: the rows stay as they were, and
// nothing on them shows it.

const refused = vi.hoisted(() => ({ labels: [] as string[], lists: [] as string[] }))
vi.mock('@/services/forbiddenStore', () => ({
  useForbiddenLabels: () => refused.labels,
  useForbiddenLists: () => new Set(refused.lists),
}))
type Layer = { source?: string; summary: string; data?: Record<string, unknown> } | null | undefined
const chat: { current: Layer } = { current: null }
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: (input: Layer) => { chat.current = input } }))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false },
  })
})

const render = (lng = 'en') => renderToStaticMarkup(createElement(I18nextProvider, { i18n: i18n.cloneInstance({ lng }) }, createElement(WatchProblemNotice)))
const watch = (path: string) => `self\n${path}?watch=1`
const refusal = (reason: string) => ({ type: 'ERROR', error: { message: 'm', reason } })

describe('a role that may list a kind and may not watch it', () => {
  beforeEach(() => {
    resetWatchProblems()
    refused.labels = []
    refused.lists = []
    chat.current = null
  })

  it('reads on the page that the rows may be old, in the screen\'s language', () => {
    recordWatchFrame(watch('/api/v1/nodes'), refusal('forbidden'))
    const html = render()
    expect(html).toContain('data-testid="watch-problem-notice"')
    expect(html).toContain('data-problem="forbidden"')
    expect(html).toContain(en.layout.watchProblem.forbidden)
    expect(render('ko')).toContain(ko.layout.watchProblem.forbidden)
  })

  it('tells the floating chat the same', () => {
    recordWatchFrame(watch('/api/v1/nodes'), refusal('forbidden'))
    render()
    expect(chat.current?.summary).toBe(en.layout.watchProblem.forbidden)
    expect(chat.current?.data).toEqual({ live_updates: 'stopped', reason: 'forbidden' })
  })

  it('says it beside a notice about another list, which does not say these rows stopped', () => {
    recordWatchFrame(watch('/api/v1/nodes'), refusal('forbidden'))
    refused.labels = ['metrics']
    refused.lists = ['metrics']
    expect(render()).toContain(en.layout.watchProblem.forbidden)
    expect(chat.current?.data).toEqual({ live_updates: 'stopped', reason: 'forbidden' })
  })

  it('leaves it to the notice about the same list, which has no rows to follow', () => {
    recordWatchFrame(watch('/api/v1/nodes'), refusal('forbidden'))
    refused.labels = ['Node']
    refused.lists = ['nodes']
    expect(render()).toBe('')
    expect(chat.current).toBeNull()
  })

  it('knows a list whose API segment the watch names otherwise', () => {
    for (const [path, list] of [
      ['/apis/apiextensions.k8s.io/v1/customresourcedefinitions', 'crds'],
      ['/api/v1/namespaces/team-a/persistentvolumeclaims', 'pvcs'],
      ['/api/v1/persistentvolumes', 'pvs'],
      ['/apis/autoscaling/v2/namespaces/team-a/horizontalpodautoscalers', 'hpas'],
      ['/apis/autoscaling.k8s.io/v1/verticalpodautoscalers', 'vpas'],
      ['/apis/policy/v1/poddisruptionbudgets', 'pdbs'],
      ['/api/v1/namespaces/team-a/pods', 'pods'],
    ]) {
      resetWatchProblems()
      recordWatchFrame(watch(path), refusal('forbidden'))
      refused.labels = ['x']
      refused.lists = [list]
      expect(render(), path).toBe('')
    }
  })

  it('still names the watch whose list answered when another one\'s did not', () => {
    recordWatchFrame(watch('/api/v1/nodes'), refusal('forbidden'))
    recordWatchFrame(watch('/api/v1/pods'), refusal('limit'))
    refused.labels = ['Node']
    refused.lists = ['nodes']
    const html = render()
    expect(html).toContain('data-problem="limit"')
    expect(html).toContain(en.layout.watchProblem.limit)
  })

  it('goes from the page and from the chat when the watch answers again', () => {
    recordWatchFrame(watch('/api/v1/nodes'), refusal('forbidden'))
    render()
    recordWatchFrame(watch('/api/v1/nodes'), { type: 'RESYNC' })
    expect(render()).toBe('')
    expect(chat.current).toBeNull()
  })
})

describe('a list past a limit of live updates', () => {
  const past = (scope: string, size: number) => ({ type: 'ERROR', error: { message: `max subscriptions reached for ${scope} (${size}), cannot create new watch`, reason: 'limit' } })
  beforeEach(() => {
    resetWatchProblems()
    refused.labels = []
    refused.lists = []
    chat.current = null
  })

  it('reads that the server is full, and asks nothing of the reader, when the limit is the server\'s', () => {
    recordWatchFrame(watch('/api/v1/nodes'), past('the server', 2000))
    const html = render()
    expect(html).toContain('data-problem="server_limit"')
    expect(html).toContain(en.layout.watchProblem.serverLimit)
    expect(en.layout.watchProblem.serverLimit).not.toMatch(/tab/i)
    expect(chat.current?.summary).toBe(en.layout.watchProblem.serverLimit)
    expect(chat.current?.data).toEqual({ live_updates: 'stopped', reason: 'server_limit' })
    expect(render('ko')).toContain(ko.layout.watchProblem.serverLimit)
    expect(ko.layout.watchProblem.serverLimit).not.toContain('탭')
  })

  // A tab has one socket and the limit is per socket: closing another tab frees nothing here.
  it('reads that this tab is full when the limit is the tab\'s, not that other tabs should close', () => {
    recordWatchFrame(watch('/api/v1/nodes'), past('this connection', 50))
    const html = render()
    expect(html).toContain('data-problem="limit"')
    expect(html).toContain(en.layout.watchProblem.limit)
    expect(render('ko')).toContain(ko.layout.watchProblem.limit)
    expect(en.layout.watchProblem.limit).not.toMatch(/other tabs/i)
    expect(ko.layout.watchProblem.limit).not.toContain('다른 탭')
  })

  it('says the rows go on being read and that live updates come back by themselves', () => {
    for (const text of [en.layout.watchProblem.limit, en.layout.watchProblem.serverLimit]) {
      expect(text).toMatch(/about once a minute/)
      expect(text).toMatch(/by themselves|goes back|go back/)
      expect(text).not.toMatch(/refresh/i)
    }
    for (const text of [ko.layout.watchProblem.limit, ko.layout.watchProblem.serverLimit]) {
      expect(text).toContain('약 1분마다')
      expect(text).toContain('실시간 갱신으로 돌아갑니다')
      expect(text).not.toContain('새로고침')
    }
  })
})

describe('the notice among the windows the floating chat is told of', () => {
  it('is never the window on top, whenever it came', () => {
    const notice = { source: 'WatchProblemNotice', summary: 'n' }
    const drawer = { source: 'ResourceDetailDrawer', summary: 'd' }
    const overlay = { source: 'LimitRangeInfo', summary: 'o' }
    expect(overlaysInOrder([drawer, overlay, notice]).map((l) => l.source)).toEqual(['WatchProblemNotice', 'ResourceDetailDrawer', 'LimitRangeInfo'])
    expect(overlaysInOrder([drawer, overlay]).map((l) => l.source)).toEqual(['ResourceDetailDrawer', 'LimitRangeInfo'])
  })
})

describe('a grant limited to namespaces, on a list of the cluster\'s objects', () => {
  beforeEach(() => {
    resetWatchProblems()
    refused.labels = []
    refused.lists = []
    chat.current = null
  })

  it('reads that its limit is why the rows do not follow, not a refusal by the cluster', () => {
    recordWatchFrame(watch('/api/v1/namespaces/team-a/namespaces'), refusal('scope'))
    const html = render()
    expect(html).toContain('data-problem="scope"')
    expect(html).toContain(en.layout.watchProblem.scope)
    expect(html).not.toContain(en.layout.watchProblem.forbidden)
    expect(render('ko')).toContain(ko.layout.watchProblem.scope)
    expect(chat.current?.data).toEqual({ live_updates: 'stopped', reason: 'scope' })
  })

  it('says nothing where the list itself was refused, which the page says', () => {
    recordWatchFrame(watch('/api/v1/namespaces/team-a/nodes'), refusal('scope'))
    refused.labels = ['Node']
    refused.lists = ['nodes']
    expect(render()).toBe('')
  })
})
