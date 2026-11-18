import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NamespaceInfo } from './namespaceHelpers'
import { useNamespacesAISnapshot } from './useNamespacesAISnapshot'

// The Namespaces screen tells the floating chat its list as other list screens do: read empty is 0, not nothing.

type Layer = { source?: string; summary: string; data?: { stats?: { total?: number }; pagination?: { total_count?: number } } } | null | undefined
const chat: { current: Layer } = { current: undefined }
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: (input: Layer) => { chat.current = input } }))

function Screen({ namespaces }: { namespaces: NamespaceInfo[] | undefined }) {
  useNamespacesAISnapshot({ namespaces, pagedNamespaces: namespaces ?? [], sortedNamespacesCount: namespaces?.length ?? 0, currentPage: 1, rowsPerPage: 20, searchQuery: '' })
  return null
}
const ns = (name: string, status: string): NamespaceInfo => ({ name, status, created_at: '2026-11-01T00:00:00Z', labels: {}, resource_count: {} })
const open = (namespaces: NamespaceInfo[] | undefined) => renderToStaticMarkup(createElement(Screen, { namespaces }))

describe('the Namespaces screen and the floating chat', () => {
  beforeEach(() => { chat.current = undefined })

  it('says 0 namespaces for a list read empty', () => {
    open([])
    expect(chat.current?.source).toBe('base')
    expect(chat.current?.data?.stats?.total).toBe(0)
    expect(chat.current?.data?.pagination?.total_count).toBe(0)
    expect(chat.current?.summary).toContain('0')
  })

  it('says nothing while the list is not read', () => {
    open(undefined)
    expect(chat.current).toBeNull()
  })

  it('counts the namespaces it read', () => {
    open([ns('default', 'Active'), ns('old', 'Terminating')])
    expect(chat.current?.data?.stats).toEqual({ total: 2, inactive: 1 })
  })
})
