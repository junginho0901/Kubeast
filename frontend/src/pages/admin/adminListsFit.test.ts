import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The admin lists and the account page's lists that grow with the data are paged. A list page fits the screen as
// the other list pages do — the page as high as the screen, the table in the space left with rows to fit it
// (useAdaptiveTable) and the shared footer with its rows-per-page choice — so the page itself never scrolls.
// A window or a card section pages its rows as the drawers do (usePagination, pagerNav).
const SRC = join(process.cwd(), 'src')
const read = (file: string) => readFileSync(join(SRC, file), 'utf8')

const FIT_PAGES = [
  'pages/AdminUsers.tsx',
  'pages/admin/AccessRequests.tsx',
  'pages/admin/AccessReview.tsx',
  'pages/AdminOrganizations.tsx',
  'pages/AdminRoles.tsx',
  'pages/admin/Clusters.tsx',
]

describe('admin list pages fit the screen', () => {
  it.each(FIT_PAGES)('%s is as high as the screen with its table fitted and the shared footer', (file) => {
    const src = read(file)
    expect(src.includes('h-[calc(100vh-4rem)]'), 'page as high as the screen').toBe(true)
    expect(src.includes('useAdaptiveTable('), 'rows to fit the table').toBe(true)
    expect(src.includes('<ListPager'), 'the shared footer').toBe(true)
    expect(src.includes('showPageSize={false}'), 'a fixed page size that makes the page scroll').toBe(false)
    expect(src.includes('page-scrolls'), 'marked as a page longer than the screen').toBe(false)
  })

  it('the server-paged lists ask for the rows the table fits', () => {
    expect(read('pages/admin/AccessRequests.tsx')).toMatch(/accessRequestQuery\([^)]*rowsPerPage, fit\)/)
    expect(read('pages/admin/AccessReview.tsx')).toMatch(/historyPage\([^)]*rowsPerPage, fit\)/)
  })

  // With Fit the first page is one block cut at the rows that fit (utils/fitServerPage): opening the list is one read,
  // not one for the count from the estimate and another for the measured one. Each page cuts the answer to its size.
  it.each([
    ['pages/AdminAudit.tsx', /auditLimitFilter\(filter, rowsPerPage, fit\)/, 'pages/AdminAudit.tsx'],
    ['pages/admin/AccessRequests.tsx', /accessRequestQuery\([^)]*rowsPerPage, fit\)/, 'pages/admin/AccessRequests.tsx'],
    ['pages/admin/AccessReview.tsx', /historyPage\(pastPage, rowsPerPage, fit\)/, 'pages/admin/AccessReview.tsx'],
    ['pages/admin/Investigations.tsx', /serverPageRead\(page, rowsPerPage, fit\)/, 'pages/admin/investigationsView.ts'],
    ['pages/admin/SessionRecordings.tsx', /serverPageRead\(page, rowsPerPage, fit\)/, 'pages/admin/SessionRecordings.tsx'],
  ])('%s reads its first page as one block and shows the rows that fit', (file, read_, shownIn) => {
    expect(read(file)).toMatch(read_)
    const shown = read(shownIn)
    expect(shown.includes('answerPageSize('), 'the page size of the answer on screen').toBe(true)
    expect(shown).toMatch(/\.slice\(0, \w+\)/)
  })

  // A key set by an effect changes a frame after the rows show, so that frame would draw the rows of the estimate.
  it.each(['pages/AdminAudit.tsx', 'pages/admin/AccessRequests.tsx', 'pages/admin/Investigations.tsx', 'pages/admin/SessionRecordings.tsx'])(
    '%s measures the rows in the render they first come in', (file) => {
      const src = read(file)
      expect(src).not.toMatch(/useEffect\(\(\) => \{\s*if \(hasRows\)/)
      expect(src).toMatch(/if \((?:hasRows && !rowsIn\) setRowsIn\(true\)|pagedRows\.length > 0 !== hasRows\) setHasRows)/)
    },
  )

  // A key set by an effect changes a frame after the rows show, so that frame would draw the rows of the estimate.
  it('Access review measures a section in the render its rows first come in', () => {
    const src = read('pages/admin/AccessReview.tsx')
    const key = /useAdaptiveTable\(\{ recalculationKey: `\$\{tab\}:\$\{(\w+)\}` \}\)/.exec(src)?.[1] ?? ''
    expect(new RegExp(`const ${key} = [^\\n]*\\brows\\.length > 0`).test(src), `the key ${key || '(none)'} reads the section's rows`).toBe(true)
  })
})

describe('lists in windows and on the account page are paged', () => {
  it.each([
    ['pages/AdminUsers.tsx', 2],
    ['pages/admin/ClusterAccessModal.tsx', 1],
    ['pages/account/ClusterAccessSection.tsx', 1],
  ])('%s pages its window or section lists as the drawers do', (file, count) => {
    expect(read(file).match(/usePagination\(/g)?.length ?? 0).toBe(count)
  })

  it('My requests turns the pages the server cuts', () => {
    const src = read('pages/account/ClusterAccessSection.tsx')
    expect(src).toMatch(/myRequestsQuery\(requestPage\)/)
    expect(src).toMatch(/listMyAccessRequestsPage\(/)
    expect(src.includes('pagerNav(')).toBe(true)
  })

  it('the API keys a person makes by hand are left whole, with the reason on the list', () => {
    expect(read('pages/account/ApiKeysSection.tsx')).toMatch(/data-testid="api-key-list"[^>]*data-list-bounded="[^"]+"|data-list-bounded="[^"]+"[^>]*data-testid="api-key-list"/)
  })
})
