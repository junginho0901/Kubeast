import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { elementsOf, fakeRender, fakeUnmount, textsOf } from '@/testing/fakeHooks'
import ResourcesTab from './helm/tabs/ResourcesTab'
import HistoryTab from './helm/tabs/HistoryTab'
import RevisionDetailModal from './helm/modals/RevisionDetailModal'
import { PodGroupList } from './resource-graph/PodGroupList'
import PolicyReports from './security/PolicyReports'
import { AuditRow } from './AdminAudit'

// The rows of these pages did something on a click only (WCAG 2.2 2.1.1): open a drawer, open a window, show a
// policy's or namespace's results, or show an audit row's details. Each now takes the Tab order and Enter or Space as
// a list row does (openOnPress); a row that has nothing to open takes neither.

vi.mock('react', async (importOriginal) => ({ ...(await importOriginal<typeof import('react')>()), ...(await import('@/testing/fakeHooks')).fakeHooks }))
const seen = vi.hoisted(() => ({ opened: [] as unknown[], answers: {} as Record<string, unknown> }))
// a read's answer by the first three words of its key
const keyOf = (queryKey: unknown[]) => queryKey.filter((k) => typeof k === 'string').slice(0, 3).join('/')
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQuery: (options: { queryKey: unknown[] }) => ({ data: seen.answers[keyOf(options.queryKey)], isLoading: false, isError: false, isSuccess: true, error: null }),
  useQueryClient: () => ({}),
}))
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string, o?: string | { defaultValue?: string }) => (typeof o === 'string' ? o : o?.defaultValue ?? key) }),
}))
vi.mock('@/components/ResourceDetailContext', () => ({ useResourceDetail: () => ({ open: (t: unknown) => seen.opened.push(t) }) }))
vi.mock('@/hooks/useAdaptiveTable', () => ({ useAdaptiveTable: () => ({ containerRef: { current: null }, bodyRef: { current: null }, theadRef: { current: null }, firstRowRef: { current: null }, rowsPerPage: 10 }) }))
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: () => undefined }))
vi.mock('@/hooks/useRefresh', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/hooks/useRefresh')>()), useRefresh: () => ({ refresh: () => {}, refreshing: false, failure: null }) }))
vi.mock('@/hooks/usePermission', () => ({ usePermission: () => ({ has: () => true }) }))

type El = { type: unknown; props: Record<string, unknown> }
const openRows = (tree: unknown) => elementsOf(tree, (props, type) => type === 'tr' && 'data-open-row' in props) as El[]
const bodyRows = (tree: unknown) => elementsOf(tree, (props, type) => type === 'tr' && props['data-testid'] === 'policy-report-row') as El[]
const text = (el: El) => textsOf(el).join('').trim()
const press = (row: El, key: string, target: unknown = row) => {
  const preventDefault = vi.fn()
  ;(row.props.onKeyDown as (e: unknown) => void)({ key, target, currentTarget: row, repeat: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, preventDefault })
  return preventDefault
}
// each row: a Tab stop that stays a row to a screen reader and opens on a click too
const expectTabStops = (rows: El[]) => rows.forEach((row) => {
  expect(row.props.tabIndex).toBe(0)
  expect(row.props).not.toHaveProperty('role')
  expect(typeof row.props.onClick).toBe('function')
})

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  fakeUnmount()
  vi.useRealTimers()
  seen.opened.length = 0
  seen.answers = {}
})

describe('a Helm release\'s tabs', () => {
  it('Resources: a row opens its object in the drawer, with the apiVersion the release names', () => {
    seen.answers['helm-resources/shop/web'] = [
      { kind: 'Deployment', apiVersion: 'apps/v1', name: 'web', namespace: 'shop' },
      { kind: 'ClusterRole', apiVersion: 'rbac.authorization.k8s.io/v1', name: 'web-reader' },
    ]
    const rows = openRows(fakeRender(() => ResourcesTab({ namespace: 'shop', name: 'web' })))
    expect(rows).toHaveLength(2)
    expectTabStops(rows)
    expect(press(rows[1], ' ')).toHaveBeenCalled()
    expect(seen.opened).toEqual([{ kind: 'ClusterRole', name: 'web-reader', namespace: undefined, apiVersion: 'rbac.authorization.k8s.io/v1' }])
  })

  it('History: Enter opens the revision\'s window, and a key on its Rollback button stays the button\'s', () => {
    seen.answers['helm-history/shop/web'] = [1, 2, 3].map((revision) => ({ revision, status: revision === 3 ? 'deployed' : 'superseded', chartVersion: '1.0.0', appVersion: '1.0.0', updated: '2026-11-20T00:00:00Z', description: `upgrade ${revision}` }))
    const render = () => fakeRender(() => HistoryTab({ namespace: 'shop', name: 'web', currentRevision: 3 }))
    const rows = openRows(render())
    expect(rows.map((r) => textsOf(r)[0])).toEqual(['3', '2', '1'])
    expectTabStops(rows)

    const [rollback] = elementsOf(rows[1], (props, type) => type === 'button' && typeof props.onClick === 'function')
    expect(press(rows[1], 'Enter', rollback)).not.toHaveBeenCalled()
    expect(elementsOf(render(), (_props, type) => type === RevisionDetailModal)).toEqual([])

    press(rows[1], 'Enter')
    const windows = elementsOf(render(), (_props, type) => type === RevisionDetailModal)
    expect(windows.map((w) => w.props.revision)).toEqual([2])
  })
})

describe('a Resource Graph group\'s window', () => {
  const group = (kind: string, more: Record<string, unknown>) => ({ id: `group:${kind}`, kind, name: 'data-*', namespace: 'shop', count: 2, ...more }) as never

  it('a Pod row opens the Pod in the drawer', () => {
    seen.answers['resource-graph-group/shop/StatefulSet/db'] = { items: [{ name: 'db-0', namespace: 'shop', status: 'Running', restart_count: 0, node_name: 'node-1' }], total: 1, stats: { total: 1, health: { ok: 1, warn: 0, error: 0 } } }
    const onOpen = vi.fn()
    const rows = openRows(fakeRender(() => PodGroupList({ group: group('Pod', { ownerKind: 'StatefulSet', ownerName: 'db' }), onClose: () => {}, onExpand: () => {}, onOpen })))
    expect(rows.map(text)).toEqual([expect.stringContaining('db-0')])
    expectTabStops(rows)
    press(rows[0], 'Enter')
    expect(onOpen).toHaveBeenCalledWith({ kind: 'Pod', name: 'db-0', namespace: 'shop' })
  })

  it('a member of a PVC group opens that PVC', () => {
    const onOpen = vi.fn()
    const rows = openRows(fakeRender(() => PodGroupList({ group: group('PersistentVolumeClaim', { members: ['data-db-0', 'data-db-1'] }), onClose: () => {}, onExpand: () => {}, onOpen })))
    expect(rows.map(text)).toEqual(['data-db-0', 'data-db-1'])
    expectTabStops(rows)
    press(rows[1], 'Enter')
    expect(onOpen).toHaveBeenCalledWith({ kind: 'PersistentVolumeClaim', name: 'data-db-1', namespace: 'shop' })
  })
})

describe('Policy Reports', () => {
  const counts = { fail: 1, warn: 0, error: 0, pass: 2, skip: 0 }
  beforeEach(() => {
    seen.answers['cluster/policyreports/status'] = { enabled: true, installed: true }
    seen.answers['cluster/policyreports/summary'] = {
      generated_at: '2026-11-20T00:00:00Z', reports: 2, truncated: false, scoped: false, totals: counts,
      policies: [{ policy: 'require-labels', source: 'kyverno', namespaces: ['web'], ...counts }],
      namespaces: [{ namespace: 'web', policies: 1, ...counts }, { namespace: '', policies: 1, ...counts }],
    }
    seen.answers['namespaces'] = []
    seen.answers['cluster/policyreports/results'] = {
      generated_at: '2026-11-20T00:00:00Z', truncated: false, scoped: false, total: 2, rows: [
        { namespace: 'web', kind: 'Pod', name: 'web-0', policy: 'require-labels', rule: 'check', result: 'fail', report: 'polr-web' },
        { namespace: 'web', kind: '', name: '', policy: 'require-labels', rule: 'check', result: 'fail', report: 'polr-web' },
      ],
    }
  })
  const render = () => fakeRender(() => PolicyReports())
  const tabShown = (tree: unknown) => elementsOf(tree, (props) => props['data-testid'] === 'policy-reports-table')[0].props['data-tab']
  // the Results tab button's ref, given a focus to watch
  const watchResultsTab = (tree: unknown) => {
    const [tab] = elementsOf(tree, (props) => props['data-testid'] === 'policy-reports-tab-results')
    const focus = vi.fn()
    ;(tab.props.ref as { current: unknown }).current = { focus }
    return focus
  }

  it('a policy row shows that policy\'s results and takes the focus to the Results tab, as its row leaves', () => {
    const tree = render()
    const focus = watchResultsTab(tree)
    const rows = openRows(tree)
    expect(rows.map(text)).toEqual([expect.stringContaining('require-labels')])
    expectTabStops(rows)
    press(rows[0], 'Enter')
    expect(focus).toHaveBeenCalledTimes(1)
    const after = render()
    expect(tabShown(after)).toBe('results')
    expect(elementsOf(after, (props) => props.testId === 'policy-reports-policy')[0]?.props.value).toBe('kyverno\nrequire-labels')
  })

  it('a namespace row shows that namespace\'s results; the cluster-scoped row has nothing to open', () => {
    const tree = render()
    const [byNamespace] = elementsOf(tree, (props) => props['data-testid'] === 'policy-reports-tab-namespaces')
    ;(byNamespace.props.onClick as () => void)()
    const shown = render()
    const focus = watchResultsTab(shown)
    const rows = bodyRows(shown)
    expect(rows.map((r) => [text(r).slice(0, 3), r.props.tabIndex, typeof r.props.onClick])).toEqual([['web', 0, 'function'], ['Clu', undefined, 'undefined']])
    press(rows[0], 'Enter')
    expect(focus).toHaveBeenCalledTimes(1)
    const after = render()
    expect(tabShown(after)).toBe('results')
    expect(elementsOf(after, (props) => props.testId === 'policy-reports-namespace')[0].props.value).toBe('web')
  })

  it('a result row opens its object; a result naming no object has nothing to open', () => {
    const tree = render()
    const [results] = elementsOf(tree, (props) => props['data-testid'] === 'policy-reports-tab-results')
    ;(results.props.onClick as () => void)()
    const rows = bodyRows(render())
    expect(rows.map((r) => [r.props.tabIndex, typeof r.props.onClick])).toEqual([[0, 'function'], [undefined, 'undefined']])
    press(rows[0], 'Enter')
    expect(seen.opened).toEqual([expect.objectContaining({ kind: 'Pod', name: 'web-0', namespace: 'web' })])
  })
})

describe('the audit log', () => {
  const entry = {
    ID: 7, CreatedAt: '2026-11-20T00:00:00Z', Service: 'k8s', Action: 'k8s.pod.delete', ActorUserID: '1', ActorEmail: 'a@kubeast.local',
    TargetID: 'web-0', TargetType: 'pod', TargetEmail: '', Cluster: 'self', Namespace: 'shop', Result: 'success', Error: '', RequestIP: '10.0.0.1',
    UserAgent: 'test', RequestID: 'r-1', Path: '/api/v1/namespaces/shop/pods/web-0',
  }
  const row = (expanded: boolean, onToggle: () => void) => fakeRender(() => AuditRow({
    entry, expanded, onToggle, resultBadge: (r) => r, fmtTime: (iso) => iso, onPlay: () => {}, playLabel: 'Play recording',
  }))

  // aria-expanded is allowed on a row only inside a treegrid (axe aria-conditional-attr): the row keeps the Tab stop
  // and the keys, and a button in it says whether the details are shown
  const toggleOf = (tree: unknown) => elementsOf(tree, (props, type) => type === 'button' && 'aria-expanded' in props) as El[]

  it('a row shows and hides its details from the keyboard and says whether they are shown', () => {
    const onToggle = vi.fn()
    const tree = row(false, onToggle)
    const closed = openRows(tree)
    expect(closed).toHaveLength(1)
    expectTabStops(closed)
    expect(closed[0].props).not.toHaveProperty('aria-expanded')
    expect(toggleOf(tree).map((b) => b.props['aria-expanded'])).toEqual([false])
    press(closed[0], 'Enter')
    expect(onToggle).toHaveBeenCalledTimes(1)

    const open = row(true, onToggle)
    expect(openRows(open)[0].props).not.toHaveProperty('aria-expanded')
    expect(toggleOf(open).map((b) => b.props['aria-expanded'])).toEqual([true])
    expect(textsOf(open)).toContain('/api/v1/namespaces/shop/pods/web-0')
    expect(press(openRows(open)[0], ' ')).toHaveBeenCalled()
    expect(onToggle).toHaveBeenCalledTimes(2)
  })

  it("the row's button has a name, no Tab stop and no click of its own: a key on it is its own, and its click goes up to the row", () => {
    const onToggle = vi.fn()
    const tree = row(false, onToggle)
    const [toggle] = toggleOf(tree)
    expect(toggle.props).toMatchObject({ type: 'button', tabIndex: -1, 'aria-label': 'Details' })
    expect(toggle.props).not.toHaveProperty('onClick')
    const [r] = openRows(tree)
    expect(press(r, 'Enter', toggle)).not.toHaveBeenCalled()
    expect(onToggle).not.toHaveBeenCalled()
    ;(r.props.onClick as () => void)()
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('no table row of the console carries aria-expanded', () => {
    const sources = import.meta.glob(['/src/**/*.tsx', '!/src/**/*.test.*'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>
    const rows = Object.entries(sources).flatMap(([path, source]) => [...source.matchAll(/<tr\b[^<]*?\baria-expanded=/g)].map(() => path))
    expect(rows).toEqual([])
    // the audit page is among the files read, its button holding the state
    expect(sources['/src/pages/AdminAudit.tsx']).toMatch(/<button\b[^<]*?\baria-expanded=\{expanded\}/)
  })
})
