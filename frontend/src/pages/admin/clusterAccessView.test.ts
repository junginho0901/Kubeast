import { describe, expect, it } from 'vitest'
import type { ClusterUserRole } from '@/services/api/admin'
import { grantsMatching } from './clusterAccessView'

// The Cluster access window pages its grants; its search looks in every grant, not only the page shown.
const grant = (i: number, over: Partial<ClusterUserRole> = {}): ClusterUserRole => ({
  user_id: `u${i}`, name: `User ${i}`, email: `user${i}@example.com`, role: 'Read', ...over,
})
const grants = Array.from({ length: 1000 }, (_, i) => grant(i))

describe('the Cluster access search', () => {
  it('finds a grant by email among a thousand, wherever its page is', () => {
    expect(grantsMatching(grants, 'user987@').map((g) => g.user_id)).toEqual(['u987'])
  })

  it('finds by name without regard to case or spaces around the words', () => {
    const list = [grant(1, { name: 'Alice Kim' }), grant(2, { name: 'Bob Lee' })]
    expect(grantsMatching(list, '  alice ').map((g) => g.user_id)).toEqual(['u1'])
  })

  it('lists every grant while the search is empty, in the order the server gave', () => {
    expect(grantsMatching(grants, '')).toEqual(grants)
    expect(grantsMatching(grants, '   ')).toEqual(grants)
  })

  it('a search that matches nothing lists nothing', () => {
    expect(grantsMatching(grants, 'nobody-at-all')).toEqual([])
  })
})
