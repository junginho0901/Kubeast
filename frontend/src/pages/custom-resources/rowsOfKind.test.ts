import { describe, expect, it } from 'vitest'
import { withRowsOfKind } from './rowsOfKind'
import pageSrc from './CustomResourceInstances.tsx?raw'
import crdInfoSrc from '@/components/resource-detail/CRDInfo.tsx?raw'
import instanceInfoSrc from '@/components/resource-detail/CustomResourceInstanceInfo.tsx?raw'

const item = (crd: string, name: string, created: string, namespace = 'shop') => ({
  name, namespace, kind: crd.split('.')[0], group: 'example.com', version: 'v1', scope: 'Namespaced', crd_name: crd, created_at: created, labels: {},
})
const list = (...items: ReturnType<typeof item>[]) => ({ items, forbidden_kinds: ['Secretish'], failed_kinds: [] }) as any
const names = (out: any) => out.items.map((i: any) => `${i.crd_name.split('.')[0]}/${i.name}`)

describe('withRowsOfKind', () => {
  const a = 'widgets.example.com'
  const b = 'gizmos.example.com'
  const before = list(item(a, 'w-1', '2026-11-07T03:00:00Z'), item(b, 'g-1', '2026-11-07T02:00:00Z'), item(a, 'w-gone', '2026-11-07T01:00:00Z'))

  it('takes a new row and drops a deleted one of that kind, the others as they were', () => {
    const out = withRowsOfKind(before, a, [
      { name: 'w-1', namespace: 'shop', created_at: '2026-11-07T03:00:00Z', labels: {} },
      { name: 'w-new', namespace: 'shop', created_at: '2026-11-07T04:00:00Z', labels: { team: 'a' } },
    ])
    expect(names(out)).toEqual(['widgets/w-new', 'widgets/w-1', 'gizmos/g-1'])
    expect(out?.items[0]).toMatchObject({ crd_name: a, kind: 'widgets', group: 'example.com', scope: 'Namespaced', labels: { team: 'a' } })
    expect(out?.forbidden_kinds).toEqual(['Secretish'])
  })

  it('keeps the server\'s order among objects of one second', () => {
    const out = withRowsOfKind(list(item(a, 'w-1', '2026-11-07T01:00:00Z'), item(b, 'g-1', '2026-11-07T01:00:00Z')), a, [
      { name: 'w-1', namespace: 'shop', created_at: '2026-11-07T01:00:00Z' },
    ])
    expect(names(out)).toEqual(['gizmos/g-1', 'widgets/w-1'])
  })

  it('empties a kind whose objects are all gone, and leaves the rest', () => {
    expect(names(withRowsOfKind(before, a, []))).toEqual(['gizmos/g-1'])
  })

  it('leaves a list that has not come, or a kind it does not know', () => {
    expect(withRowsOfKind(undefined, a, [])).toBeUndefined()
    expect(withRowsOfKind(before, 'other.example.com', [])).toBe(before)
  })
})

describe('what follows a custom resource', () => {
  it('the page, its chosen kind', () => {
    expect(pageSrc).toContain('useWatchChanges({')
    expect(pageSrc).toContain("read: [['custom-resources', 'full-instances', selectedGroup, selectedVersion, selectedPlural]],")
    expect(pageSrc).toContain("'crInstancesPage.notLive'")
  })

  it('a CRD drawer, its instances', () => {
    expect(crdInfoSrc).toContain('useWatchChanges({')
    expect(crdInfoSrc).toContain("read: [['crd-instances', group, storageVersion, plural]],")
  })

  it('a custom resource drawer, its object', () => {
    expect(instanceInfoSrc).toContain('useWatchChanges({')
    expect(instanceInfoSrc).toContain('fieldSelector: `metadata.name=${name}`')
  })
})
