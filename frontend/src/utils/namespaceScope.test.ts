import { describe, expect, it } from 'vitest'
import { parseNamespaceList, sameNamespaces } from './namespaceScope'
import { scopedPaths } from '@/services/useKubeWatchList'

describe('namespace scope', () => {
  it('parses a typed list: separators, case, duplicates, order', () => {
    expect(parseNamespaceList(' Web, api  web\napi,')).toEqual(['api', 'web'])
    expect(parseNamespaceList('')).toEqual([])
    expect(sameNamespaces(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(sameNamespaces(undefined, [])).toBe(true)
    expect(sameNamespaces(['a'], ['a', 'b'])).toBe(false)
  })

  it('rewrites an all-namespaces watch path per granted namespace', () => {
    expect(scopedPaths('/api/v1/pods', ['api', 'web'])).toEqual(['/api/v1/namespaces/api/pods', '/api/v1/namespaces/web/pods'])
    expect(scopedPaths('/apis/apps/v1/deployments', ['web'])).toEqual(['/apis/apps/v1/namespaces/web/deployments'])
    // Already namespaced, or no scope: untouched.
    expect(scopedPaths('/api/v1/namespaces/web/pods', ['api'])).toEqual(['/api/v1/namespaces/web/pods'])
    expect(scopedPaths('/api/v1/pods', undefined)).toEqual(['/api/v1/pods'])
    expect(scopedPaths('/api/v1/pods', [])).toEqual(['/api/v1/pods'])
  })
})
