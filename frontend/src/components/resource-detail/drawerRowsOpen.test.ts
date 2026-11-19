import { afterEach, describe, expect, it, vi } from 'vitest'
import { elementsOf, fakeRender, fakeUnmount, textsOf } from '@/testing/fakeHooks'
import WorkloadOwnedResources from './workload-info/WorkloadOwnedResources'
import PVCDetail from './config-storage-info/PVCDetail'
import StorageClassDetail from './config-storage-info/StorageClassDetail'
import IngressClassDetail from './network-info/IngressClassDetail'

// A table inside the drawer opened another object from a row on a click only (WCAG 2.2 2.1.1). Those rows now take the
// Tab order and Enter as the list rows do (openOnPress), and each shows the name of what it opens, which is how Back
// gives the focus to it again (drawerFocus rowOpening).

vi.mock('react', async (importOriginal) => ({ ...(await importOriginal<typeof import('react')>()), ...(await import('@/testing/fakeHooks')).fakeHooks }))
const seen = vi.hoisted(() => ({ opened: [] as unknown[], answers: {} as Record<string, unknown> }))
vi.mock('@/components/ResourceDetailContext', () => ({ useResourceDetail: () => ({ open: (t: unknown) => seen.opened.push(t) }) }))
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQuery: (options: { queryKey: unknown[] }) => ({ data: seen.answers[String(options.queryKey[0])], isLoading: false, error: null, dataUpdatedAt: 1 }),
}))
vi.mock('./useDrawerFollowsEvents', () => ({ useDrawerFollowsEvents: () => undefined }))
vi.mock('@/hooks/useResourceDetailOverlay', () => ({ useResourceDetailOverlay: () => undefined }))
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string, o?: { defaultValue?: string }) => o?.defaultValue ?? key }),
}))

type Row = { type: unknown; props: Record<string, unknown> }
const rowsOf = (tree: unknown) => elementsOf(tree, (props, type) => type === 'tr' && 'data-open-row' in props) as Row[]
const cellsOf = (row: Row) => elementsOf(row, (_props, type) => type === 'td').map((td) => textsOf(td).join('').trim())
const key = (row: Row, k: string) => {
  const preventDefault = vi.fn()
  ;(row.props.onKeyDown as (e: unknown) => void)({ key: k, target: row, currentTarget: row, repeat: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, preventDefault })
  return preventDefault
}

// each row: a Tab stop, a row to a screen reader, Enter opens its object, and a cell names that object
function expectRowsOpen(tree: unknown, targets: { kind: string; name: string; namespace?: string }[]) {
  const rows = rowsOf(tree)
  expect(rows).toHaveLength(targets.length)
  rows.forEach((row, i) => {
    expect(row.props.tabIndex).toBe(0)
    expect(row.props).not.toHaveProperty('role')
    expect(typeof row.props.onClick).toBe('function')
    key(row, 'Enter')
    expect(seen.opened[i]).toEqual(targets[i])
    const t = targets[i]
    const cells = cellsOf(row)
    expect(cells.includes(t.name) || cells.includes(`${t.namespace}/${t.name}`)).toBe(true)
  })
}

afterEach(() => {
  fakeUnmount()
  seen.opened.length = 0
  seen.answers = {}
})

describe('a table inside the drawer', () => {
  it('a workload\'s pods open each Pod from the keyboard', () => {
    const pods = ['web-0', 'web-1'].map((name) => ({ name, namespace: 'shop', status: 'Running', phase: 'Running', ready: '1/1', restart_count: 0, node_name: 'node-1' }))
    const owned = {
      replicaSets: [], jobs: [], pvcsByPodName: new Map(), rsEnabled: false, jobsEnabled: false, pvcsEnabled: false, podsEnabled: true,
      podTable: { whole: pods, page: undefined, items: pods, total: pods.length, loading: false, note: null },
    }
    const tree = fakeRender(() => WorkloadOwnedResources({
      namespace: 'shop', owned: owned as never, isCronJob: false, isDaemonSet: false, isDeployment: false, isJob: false, isReplicaSet: true,
      isStatefulSet: false, describe: undefined, ownedJobs: undefined,
    }))
    expectRowsOpen(tree, [{ kind: 'Pod', name: 'web-0', namespace: 'shop' }, { kind: 'Pod', name: 'web-1', namespace: 'shop' }])
  })

  it('a StorageClass\'s volumes and claims open the PV and the PVC, and Space does not scroll the drawer', () => {
    seen.answers['storageclass-describe'] = {
      related_pvs: [{ name: 'pv-1', status: 'Bound', capacity: '1Gi', claim_ref: { namespace: 'shop', name: 'data' } }],
      related_pvcs: [{ name: 'data', namespace: 'shop', status: 'Bound', requested: '1Gi', capacity: '1Gi', volume: 'pv-1' }],
    }
    const tree = fakeRender(() => StorageClassDetail({ name: 'fast' }))
    expectRowsOpen(tree, [{ kind: 'PersistentVolume', name: 'pv-1' }, { kind: 'PersistentVolumeClaim', name: 'data', namespace: 'shop' }])
    expect(key(rowsOf(tree)[0], ' ')).toHaveBeenCalled()
  })

  it('an IngressClass\'s Ingresses open each Ingress', () => {
    seen.answers['ingressclass-used-by'] = [{ name: 'shop-web', namespace: 'shop' }, { name: 'ops-web', namespace: 'ops' }]
    const tree = fakeRender(() => IngressClassDetail({ name: 'nginx' } as never))
    expectRowsOpen(tree, [{ kind: 'Ingress', name: 'shop-web', namespace: 'shop' }, { kind: 'Ingress', name: 'ops-web', namespace: 'ops' }])
  })

  it('a PVC\'s pods open the Pod, and a row with no pod name opens nothing on a key or a click', () => {
    seen.answers['pvc-describe'] = { used_by_pods: [{ name: 'web-0', namespace: 'shop', status: 'Running' }, { namespace: 'shop' }] }
    const tree = fakeRender(() => PVCDetail({ name: 'data', namespace: 'shop' }))
    const rows = rowsOf(tree)
    expect(rows).toHaveLength(2)
    key(rows[0], 'Enter')
    expect(seen.opened).toEqual([{ kind: 'Pod', name: 'web-0', namespace: 'shop' }])
    key(rows[1], 'Enter')
    ;(rows[1].props.onClick as () => void)()
    expect(seen.opened).toHaveLength(1)
  })
})
