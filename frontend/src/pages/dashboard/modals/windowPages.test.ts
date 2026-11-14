import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import en from '@/i18n/locales/en.json'
import type { IssueItem } from '../types'
import { IssuesModal } from './IssuesModal'
import { StorageModal } from './StorageModal'
import { WINDOW_PAGE, issuesOnPage } from './windowPages'

// The dashboard's Issues and Storage windows drew every row they were given: a cluster in trouble lists thousands of
// issues and a big one thousands of claims, volumes and topology lines. They page them 50 at a time as the window
// behind a stat card does, with the list footer, and each kind's heading in Issues keeps the count of its whole kind.

vi.mock('@/components/ModalOverlay', () => ({ ModalOverlay: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: () => {} }))

const i18n = i18next.createInstance()
beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } })
})
const render = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(I18nextProvider, { i18n }, el))

const n = (i: number) => String(i).padStart(3, '0')
const issue = (kind: string, i: number): IssueItem => ({ id: `${kind}/ns/${kind.toLowerCase()}-${n(i)}`, kind, severity: 'warning', name: `${kind.toLowerCase()}-${n(i)}`, namespace: 'ns', title: `${kind.toLowerCase()}-${n(i)}` } as IssueItem)
// 70 pods then 50 Jobs, in the order the window lists them
const kinds = ['Pod', 'Job']
const byKind: Record<string, IssueItem[]> = { Pod: Array.from({ length: 70 }, (_, i) => issue('Pod', i)), Job: Array.from({ length: 50 }, (_, i) => issue('Job', i)) }
const sorted = [...byKind.Pod, ...byKind.Job]

describe('a page of the Issues window', () => {
  it('cuts the issues in the order they are listed and puts them back under their kind', () => {
    expect(WINDOW_PAGE).toBe(50)
    const first = issuesOnPage(kinds, byKind, 1)
    expect(first).toMatchObject({ page: 1, pages: 3, total: 120 })
    expect(first.groups.map((g) => [g.kind, g.total, g.rows.length])).toEqual([['Pod', 70, 50]])
    const second = issuesOnPage(kinds, byKind, 2)
    // the last 20 pods and the first 30 Jobs, each heading with the count of its whole kind
    expect(second.groups.map((g) => [g.kind, g.total, g.rows.length])).toEqual([['Pod', 70, 20], ['Job', 50, 30]])
    expect(second.groups[0].rows[0].name).toBe('pod-050')
    expect(issuesOnPage(kinds, byKind, 3).groups.map((g) => [g.kind, g.rows.length])).toEqual([['Job', 20]])
    // a page past the end shows the last one
    expect(issuesOnPage(kinds, byKind, 9).page).toBe(3)
  })

  it('draws the first 50 rows, the whole kind\'s count and a footer that counts every issue', () => {
    const html = render(createElement(IssuesModal, {
      open: true, onClose: () => {}, includeRestartHistory: false, setIncludeRestartHistory: () => {}, windowMinutes: null, setWindowMinutes: () => {},
      defaultWindowMinutes: 60, searchQuery: '', setSearchQuery: () => {}, isLoading: false, sortedIssues: sorted, issuesByKind: byKind, kinds,
      issuesSummary: { total: 120, critical: 0, warning: 120, info: 0, all: 120 }, onOpenIssue: () => {},
    }))
    expect(html.match(/data-testid="issue-row"/g)).toHaveLength(50)
    expect(html).toContain('pod-049')
    expect(html).not.toContain('pod-050')
    expect(html).toMatch(/data-testid="issues-kind-Pod"[\s\S]*?<span class="text-xs text-slate-400">70<\/span>/)
    expect(html).toContain('data-testid="issues-pager"')
    expect(html).toContain('Showing 1-50 of 120')
    // a title cut at the row's width keeps its whole text on hover
    expect(html).toContain('title="pod-000"')
  })
})

describe('the Storage window', () => {
  const pvcs = Array.from({ length: 120 }, (_, i) => ({ name: `claim-${n(i)}`, namespace: 'ns', status: 'Bound', capacity: '1Gi', storage_class: 'standard', volume_name: `pv-${n(i)}` }))
  const pvs = Array.from({ length: 75 }, (_, i) => ({ name: `pv-${n(i)}`, status: 'Bound', capacity: '1Gi', storage_class: 'standard', reclaim_policy: 'Delete', claim_ref: { namespace: 'ns', name: `claim-${n(i)}` } }))
  const edges = Array.from({ length: 60 }, (_, i) => ({ id: `e${i}`, source: `pvc/ns/claim-${n(i)}`, target: `pv/pv-${n(i)}` }))
  const window = (activeTab: 'pvcs' | 'pvs' | 'topology') => render(createElement(StorageModal, {
    open: true, onClose: () => {}, sortedPVCs: pvcs, sortedPVs: pvs, pvcStatusCounts: { Bound: 120 }, pvStatusCounts: { Bound: 75 },
    activeTab, setActiveTab: () => {}, namespaceFilter: 'all', setNamespaceFilter: () => {}, namespaces: ['ns'], isDropdownOpen: false,
    setIsDropdownOpen: () => {}, searchQuery: '', setSearchQuery: () => {}, isLoading: false, storageTopology: { nodes: [], edges },
    isLoadingStorageTopology: false, isStorageTopologyError: false, storageTopologyError: null,
  }))

  it('PVCs: the first 50 of 120 and the footer', () => {
    const html = window('pvcs')
    expect(html).toContain('title="claim-049"')
    expect(html).not.toContain('title="claim-050"')
    expect(html).toContain('data-testid="storage-pager"')
    expect(html).toContain('Showing 1-50 of 120')
  })

  it('PVs: the first 50 of 75 and the footer', () => {
    const html = window('pvs')
    expect(html).toContain('title="pv-049"')
    expect(html).not.toContain('title="pv-050"')
    expect(html).toContain('Showing 1-50 of 75')
  })

  it('Topology: the first 50 of 60 lines and the footer', () => {
    const html = window('topology')
    expect(html).toContain('pvc/ns/claim-049 → pv/pv-049')
    expect(html).not.toContain('pvc/ns/claim-050')
    expect(html).toContain('Showing 1-50 of 60')
  })
})
