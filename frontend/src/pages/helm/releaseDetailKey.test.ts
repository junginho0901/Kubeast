import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

// The release page's route keeps its element when only the address's namespace or name, or the cluster, changes (a
// drawer's Helm badge, back, forward). The page it draws is keyed by the three, so release B starts on its own tab with
// none of release A's windows, edits or sub-windows (the Values edit, Uninstall, Run tests, a revision's window).

const at = vi.hoisted(() => ({ cluster: 'c1', namespace: 'shop', name: 'web' }))
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useParams: () => ({ namespace: at.namespace, name: at.name }),
}))
vi.mock('@/contexts/ClusterContext', () => ({ useCluster: () => ({ currentCluster: at.cluster }) }))

const { default: HelmReleaseDetailPage } = await import('./ReleaseDetail')

const pageOf = (cluster: string, namespace: string, name: string) => {
  Object.assign(at, { cluster, namespace, name })
  return HelmReleaseDetailPage() as ReactElement
}

describe('the Helm release page', () => {
  it('is a page of its own for each cluster, namespace and release', () => {
    const web = pageOf('c1', 'shop', 'web')
    expect(web.key).not.toBeNull()
    expect(pageOf('c1', 'shop', 'web').key).toBe(web.key)
    expect(pageOf('c1', 'shop', 'api').key).not.toBe(web.key)
    expect(pageOf('c1', 'payments', 'web').key).not.toBe(web.key)
    expect(pageOf('c2', 'shop', 'web').key).not.toBe(web.key)
  })
})
