import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { elementsOf, fakeRender, fakeUnmount, textsOf } from '@/testing/fakeHooks'

// The log files box said "Following stopped: …" of the file it followed under another container, pod or file, and a
// pod's Logs tab said "Logs not downloaded: …" under the container picked after the one whose download failed. Each
// line now goes with the container, pod and file it was about.

vi.mock('react', async (importOriginal) => ({ ...(await importOriginal<typeof import('react')>()), ...(await import('@/testing/fakeHooks')).fakeHooks }))
const fill = (text: string, values?: Record<string, unknown>) => text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? ''))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, a?: unknown, b?: Record<string, unknown>) => (typeof a === 'string' ? fill(a, b) : (a as { defaultValue?: string } | undefined)?.defaultValue ?? key) }),
}))
vi.mock('@/contexts/ClusterContext', () => ({ useCluster: () => ({ currentCluster: 'c1' }) }))
vi.mock('@/hooks/usePrometheusQuery', () => ({ useClusterFeatures: () => ({ data: undefined }) }))
vi.mock('@/hooks/useLogFilesAvailable', () => ({ useLogFilesAvailable: () => false }))
vi.mock('@/hooks/useLogSearchAvailable', () => ({ useLogSearchAvailable: () => false }))
vi.mock('@/hooks/useDismiss', () => ({ useDismiss: () => {} }))
const FILES = ['/var/log/app.log', '/var/log/audit.log']
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQuery: (options: { queryKey: unknown[] }) => (options.queryKey[0] === 'log-files'
    ? { data: { files: FILES.map((path) => ({ path })), patterns: [] }, isLoading: false, isError: false, refetch: () => {} }
    : { data: { content: 'line' }, isFetching: false, isError: false, refetch: () => {} }),
}))

import { api } from '@/services/api'
import { LogFilesView } from '@/components/LogFilesView'
import { PodLogsTab } from '@/pages/cluster-view/PodLogsTab'

// the EventSources the views open, each firing what the test says
class FakeEventSource {
  static CLOSED = 2
  static opened: FakeEventSource[] = []
  readyState = 1
  listeners = new Map<string, ((e: unknown) => void)[]>()
  onopen: (() => void) | null = null
  onmessage: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  constructor(public url: string) { FakeEventSource.opened.push(this) }
  addEventListener(name: string, fn: (e: unknown) => void) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]) }
  fire(name: string, data?: string) { for (const fn of this.listeners.get(name) ?? []) fn({ data }) }
  close() { this.readyState = FakeEventSource.CLOSED }
}

beforeEach(() => {
  FakeEventSource.opened = []
  vi.stubGlobal('EventSource', FakeEventSource)
})
afterEach(() => {
  fakeUnmount()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the log files box', () => {
  const STOPPED = 'Following stopped.'
  function followedThenStopped(props: { namespace: string; pod: string; container: string }) {
    FakeEventSource.opened = []
    const box = { props }
    const render = () => fakeRender(() => LogFilesView(box.props))
    let tree = render()
    const follow = elementsOf(tree, (p) => p['data-testid'] === 'logfile-follow')[0]
    ;(follow.props.onClick as () => void)()
    render()
    expect(FakeEventSource.opened.map((es) => new URL(es.url, 'http://x').searchParams.get('path'))).toEqual([FILES[0]])
    FakeEventSource.opened[0].fire('end')
    tree = render()
    expect(textsOf(tree).join(''), 'the line once the stream ended').toContain(STOPPED)
    return { box, render }
  }

  it('says why following stopped while the same file of the same container is on screen', () => {
    const { render } = followedThenStopped({ namespace: 'shop', pod: 'web-0', container: 'app' })
    expect(textsOf(render()).join('')).toContain(STOPPED)
  })

  it('does not say it under another container, pod or file', () => {
    const start = { namespace: 'shop', pod: 'web-0', container: 'app' }
    const { box, render } = followedThenStopped(start)
    box.props = { ...start, container: 'sidecar' }
    expect(textsOf(render()).join(''), 'another container').not.toContain(STOPPED)

    fakeUnmount()
    const again = followedThenStopped(start)
    again.box.props = { ...start, pod: 'web-1' }
    expect(textsOf(again.render()).join(''), 'another pod').not.toContain(STOPPED)

    fakeUnmount()
    const third = followedThenStopped(start)
    const file = elementsOf(third.render(), (p) => p.testId === 'logfile-select')[0]
    ;(file.props.onChange as (v: string) => void)(FILES[1])
    expect(textsOf(third.render()).join(''), 'another file').not.toContain(STOPPED)
  })
})

describe('a pod\'s Logs tab', () => {
  const pod = { name: 'web-0', namespace: 'shop', containers: [{ name: 'app' }, { name: 'sidecar' }] }
  const tr = (_key: string, fallback: string, values?: Record<string, unknown>) => fill(fallback, values)
  const errorLine = (tree: unknown) => elementsOf(tree, (p) => p['data-testid'] === 'pod-logs-download-error')

  async function failedDownload() {
    vi.spyOn(api, 'getPodLogs').mockRejectedValue(Object.assign(new Error('Request failed with status code 403'), { response: { status: 403, data: { detail: 'pods/log is forbidden' } } }))
    const tab = { props: { pod, selectedContainer: 'app', onSelectContainer: () => {}, containerSearchQuery: '', onContainerSearchChange: () => {}, tr } }
    const render = () => fakeRender(() => PodLogsTab(tab.props))
    const tree = render()
    const download = elementsOf(tree, (p, type) => type === 'button' && textsOf(p.children).includes('Download'))
    expect(download, 'the Download button').toHaveLength(1)
    await (download[0].props.onClick as () => Promise<void>)()
    const after = render()
    expect(textsOf(errorLine(after)).join(''), 'the line once the download failed').toBe('Logs not downloaded: pods/log is forbidden')
    return { tab, render }
  }

  it('says why the download failed while that container is picked', async () => {
    const { render } = await failedDownload()
    expect(errorLine(render())).toHaveLength(1)
  })

  it('does not say it under another container', async () => {
    const { tab, render } = await failedDownload()
    tab.props = { ...tab.props, selectedContainer: 'sidecar' }
    expect(errorLine(render())).toEqual([])
  })
})
