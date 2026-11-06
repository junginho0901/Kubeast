import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import en from '../../i18n/locales/en.json'
import ClusterAccessModal from './ClusterAccessModal'
import ClusterRoleMatrix from './ClusterRoleMatrix'
import { refusalText } from './clusterAccessRefusal'
import type { ClusterMeta } from '@/services/api/clusters'

// the window's overlay is a portal into the page, which a static render has not got
vi.mock('@/components/ModalOverlay', () => ({ ModalOverlay: ({ children }: { children: ReactNode }) => children }))

const REFUSED = { response: { status: 403, data: { detail: 'permission ceiling: you do not hold what this role grants' } }, message: 'Request failed with status code 403' }

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } })
})

// retryOnMount off: a static render shows a failed read as it stands, not as the new try a mount would start
const render = (el: ReactElement, data: [QueryKey, unknown][], failed: [QueryKey, unknown][] = []) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } })
  for (const [key, value] of data) qc.setQueryData(key, value)
  for (const [key, error] of failed) {
    qc.getQueryCache().build(qc, { queryKey: key }).setState({ status: 'error', error: error as Error, fetchStatus: 'idle', data: undefined })
  }
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(QueryClientProvider, { client: qc }, el)))
}

describe('what a cluster access refusal says', () => {
  it('is the server\'s reason', () => {
    expect(refusalText(REFUSED)).toBe('permission ceiling: you do not hold what this role grants')
  })

  it('without one, the request\'s own error', () => {
    expect(refusalText({ response: { status: 500, data: {} }, message: 'Request failed with status code 500' })).toBe('Request failed with status code 500')
    expect(refusalText(new Error('Network Error'))).toBe('Network Error')
  })

  it('is nothing without an error', () => {
    expect(refusalText(null)).toBeNull()
    expect(refusalText(undefined)).toBeNull()
  })
})

describe('the user\'s Cluster access', () => {
  const USER = 'u1'
  const clusters: [QueryKey, unknown] = [['clusters-all', false], [{ id: 'c1', display_name: 'one' }]]
  const roles: [QueryKey, unknown] = [['roles'], [{ name: 'Read' }]]
  const props = { userID: USER, canEdit: true }

  it('does not read "No access" when the user\'s grants could not be read', () => {
    const html = render(createElement(ClusterRoleMatrix, props), [clusters, roles, [['user-cluster-grants', USER], []]], [[['user-cluster-roles', USER], REFUSED]])
    expect(html).toContain('data-testid="cluster-role-matrix-error"')
    expect(html).toContain(REFUSED.response.data.detail)
    expect(html).not.toContain('data-testid="cluster-role-matrix"')
  })

  it('does not read "No clusters registered" when the clusters could not be read', () => {
    const html = render(createElement(ClusterRoleMatrix, props), [roles, [['user-cluster-roles', USER], {}], [['user-cluster-grants', USER], []]], [[['clusters-all', false], REFUSED]])
    expect(html).toContain(REFUSED.response.data.detail)
    expect(html).not.toContain('No clusters registered.')
  })

  it('keeps the rows when only the roles could not be read, and says why the list is short', () => {
    const html = render(createElement(ClusterRoleMatrix, props), [clusters, [['user-cluster-roles', USER], { c1: 'Read' }], [['user-cluster-grants', USER], []]], [[['roles'], REFUSED]])
    expect(html).toContain('data-testid="cluster-role-matrix"')
    expect(html).toContain(REFUSED.response.data.detail)
  })

  it('shows no refusal when everything was read', () => {
    const html = render(createElement(ClusterRoleMatrix, props), [clusters, roles, [['user-cluster-roles', USER], {}], [['user-cluster-grants', USER], []]])
    expect(html).toContain('data-testid="cluster-role-matrix"')
    expect(html).not.toContain('cluster-role-matrix-error')
  })
})

describe('the cluster\'s access window', () => {
  const cluster = { id: 'c1', display_name: 'one' } as ClusterMeta
  const el = () => createElement(ClusterAccessModal, { cluster, onClose: () => {} })
  const roles: [QueryKey, unknown] = [['roles'], [{ name: 'Read' }]]
  const users: [QueryKey, unknown] = [['admin-users', 'all'], [{ id: 'u2', name: 'two' }]]
  const grants: [QueryKey, unknown] = [['cluster-user-roles', 'c1'], []]

  it('does not read "No users have access" when the grants could not be read', () => {
    const html = render(el(), [roles, users], [[['cluster-user-roles', 'c1'], REFUSED]])
    expect(html).toContain('data-testid="cluster-access-error"')
    expect(html).toContain(REFUSED.response.data.detail)
    expect(html).not.toContain('No users have access to this cluster yet.')
  })

  it('does not read "All users already granted" when the users could not be read', () => {
    const html = render(el(), [roles, grants], [[['admin-users', 'all'], REFUSED]])
    expect(html).toContain(REFUSED.response.data.detail)
    expect(html).not.toContain('All users already granted')
  })

  it('shows no refusal when everything was read', () => {
    expect(render(el(), [roles, users, grants])).not.toContain('cluster-access-error')
  })
})

// A refused change happens on a click, which a static render cannot make: number-check-cluster-access.spec.ts presses it.
describe('a refused change', () => {
  for (const file of ['./ClusterRoleMatrix.tsx', './ClusterAccessModal.tsx']) {
    it(`${file} keeps the reason of both its changes`, () => {
      const src = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')
      expect(src.match(/onError: \(err\) => setRefusal\(refusalText\(err\)\)/g)?.length).toBe(2)
      expect(src.match(/onMutate: \(\) => setRefusal\(null\)/g)?.length).toBe(2)
    })
  }
})
