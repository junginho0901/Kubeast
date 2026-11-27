import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import i18next from 'i18next'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import { elementsOf, fakeRender, fakeUnmount, textsOf } from '@/testing/fakeHooks'
import { isPrivateScreen } from '@/utils/aiContext/privateScreens'
import type { AccessReviewRoleRow } from '@/services/api/access_review'

const ui = vi.hoisted(() => ({ lang: 'en', layer: vi.fn() }))
const i18n = i18next.createInstance()
vi.mock('react', async (original) => ({ ...(await original<typeof import('react')>()), ...(await import('@/testing/fakeHooks')).fakeHooks }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: unknown) => i18n.getFixedT(ui.lang)(key, options as never), i18n: { language: ui.lang } }) }))
vi.mock('@/hooks/useAIContext', () => ({ useAIContext: (input: unknown) => ui.layer(input) }))
vi.mock('react-router-dom', async (original) => ({ ...(await original<typeof import('react-router-dom')>()), useLocation: () => ({ pathname: '/admin/access-review' }) }))

import { AccessReviewRolePermissions } from './AccessReviewRolePermissions'
import { ModalFrame } from '@/components/ModalFrame'
import { ListPager } from '@/components/ListPager'
import { PageContextProvider } from '@/components/PageContextProvider'

beforeAll(async () => {
  await i18n.init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false } })
})
beforeEach(() => { ui.lang = 'en'; ui.layer.mockClear() })
afterEach(() => fakeUnmount())

type Props = Record<string, unknown>
const role = (permissions: string[]): AccessReviewRoleRow => ({ name: 'review-reader', permissions, description: 'Read access', is_system: false, users: 2, cluster_bindings: 3, flags: [] })
const permission = (i: number) => `resource.kind-${i}.read`
const cell = (r: AccessReviewRoleRow) => fakeRender(() => AccessReviewRolePermissions({ role: r }))
const one = (tree: unknown, match: (props: Props, type: unknown) => boolean) => {
  const found = elementsOf(tree, match)
  expect(found).toHaveLength(1)
  return found[0].props
}
const opener = (tree: unknown) => one(tree, (p, type) => type === 'button' && p['aria-haspopup'] === 'dialog')
const windowOf = (tree: unknown) => one(tree, (_p, type) => type === ModalFrame)
const pagerOf = (tree: unknown) => one(tree, (_p, type) => type === ListPager)
const shownPermissions = (tree: unknown) => elementsOf(tree, (_p, type) => type === 'li').map((el) => textsOf(el).join(''))
const press = (p: Props) => (p.onClick as () => void)()
const open = (r: AccessReviewRoleRow) => { press(opener(cell(r))); return cell(r) }

describe('Access Review: the permissions of one role', () => {
  it('keeps an empty permission cell as a dash and opens no window', () => {
    const tree = cell(role([]))
    expect(textsOf(tree)).toEqual(['-'])
    expect(elementsOf(tree, (_p, type) => type === 'button' || type === ModalFrame)).toEqual([])
    expect(ui.layer).toHaveBeenLastCalledWith(null)
  })

  it.each([1, 10, 11, 31])('counts all %i permissions, not one page of them', (total) => {
    const r = role(Array.from({ length: total }, (_, i) => permission(i)))
    const summary = textsOf({ props: opener(cell(r)) }).join('')
    expect(summary).toBe(`${total} permission${total === 1 ? '' : 's'} — review-reader`)
    const tree = open(r)
    expect(textsOf(windowOf(tree).subtitle).join('')).toBe(`Permissions in this role: ${total}.`)
    expect(pagerOf(tree)).toMatchObject({ total, rowsPerPage: 10, showPageSize: false, totalPages: Math.ceil(total / 10) })
    expect(shownPermissions(tree)).toEqual(r.permissions.slice(0, 10))
    expect(ui.layer.mock.calls.at(-1)?.[0].data.total).toBe(total)
  })

  it('every page keeps the order, complete strings and duplicates from the same report row', () => {
    const permissions = Array.from({ length: 23 }, (_, i) => permission(i))
    permissions[3] = 'resource.매우-긴-이름-with-no-spaces.' + 'x'.repeat(180)
    permissions[17] = permissions[3]
    const r = role(permissions)
    const original = [...permissions]
    let tree = open(r)
    const all = [...shownPermissions(tree)]
    for (const page of [2, 3]) {
      ;(pagerOf(tree).onPageChange as (p: number) => void)(page)
      tree = cell(r)
      expect(pagerOf(tree).currentPage).toBe(page)
      all.push(...shownPermissions(tree))
      expect(ui.layer.mock.calls.at(-1)?.[0].data).toEqual({ role: r.name, total: 23, page, page_size: 10, permissions: shownPermissions(tree) })
    }
    expect(all).toEqual(original)
    expect(r.permissions).toEqual(original)
  })

  it('both close paths close the window, and reopening starts on the first page', () => {
    const r = role(Array.from({ length: 23 }, (_, i) => permission(i)))
    for (const how of ['frame', 'footer']) {
      let tree = open(r)
      ;(pagerOf(tree).onPageChange as (p: number) => void)(3)
      tree = cell(r)
      expect(shownPermissions(tree)).toEqual(r.permissions.slice(20))
      const frame = windowOf(tree)
      if (how === 'frame') (frame.onClose as () => void)()
      else press(one(frame.footer, (_p, type) => type === 'button'))
      tree = cell(r)
      expect(elementsOf(tree, (_p, type) => type === ModalFrame)).toEqual([])
      expect(ui.layer).toHaveBeenLastCalledWith(null)
      tree = open(r)
      expect(pagerOf(tree).currentPage).toBe(1)
      ;(windowOf(tree).onClose as () => void)()
    }
  })

  it('a refreshed row supplies the count and the window together, including an empty answer', () => {
    const r = role(Array.from({ length: 23 }, (_, i) => permission(i)))
    let tree = open(r)
    ;(pagerOf(tree).onPageChange as (p: number) => void)(3)
    tree = cell({ ...r, permissions: ['resource.pod.read'] })
    expect(textsOf({ props: opener(tree) }).join('')).toBe('1 permission — review-reader')
    expect(shownPermissions(tree)).toEqual(['resource.pod.read'])
    expect(pagerOf(tree)).toMatchObject({ currentPage: 1, totalPages: 1, total: 1 })
    tree = cell({ ...r, permissions: [] })
    expect(shownPermissions(tree)).toEqual([])
    expect(textsOf(tree)).toContain('None')
    expect(pagerOf(tree)).toMatchObject({ total: 0, currentPage: 1 })
    expect(ui.layer.mock.calls.at(-1)?.[0].data).toMatchObject({ total: 0, permissions: [] })
  })

  it('uses the Korean count and a formal explanation without translating permission keys', () => {
    ui.lang = 'ko'
    const r = role(['admin.audit.read'])
    const tree = open(r)
    expect(textsOf({ props: opener(tree) }).join('')).toBe('권한 1개 — review-reader')
    expect(windowOf(tree).subtitle).toBe('이 역할의 권한 1개를 표시합니다.')
    expect(shownPermissions(tree)).toEqual(['admin.audit.read'])
  })

  it('uses native buttons for keyboard activation and the shared frame for dismissal', () => {
    const tree = open(role(['admin.audit.read']))
    expect(opener(tree).type).toBe('button')
    expect(opener(tree).onKeyDown).toBeUndefined()
    expect(opener(tree).tabIndex).toBeUndefined()
    expect(windowOf(tree)).toMatchObject({ body: 'fill', size: 'md', testId: 'access-review-role-permissions' })
    expect(one(tree, (p) => p['data-list'] === 'Role permissions')).toBeDefined()
    expect(pagerOf(tree).showPageSize).toBe(false)
  })

  it('keeps Access Review a private screen even while its information window is registered', () => {
    open(role(['admin.audit.read']))
    const layer = ui.layer.mock.calls.at(-1)?.[0]
    expect(layer.data.permissions).toEqual(['admin.audit.read'])
    expect(isPrivateScreen('/admin/access-review')).toBe(true)
    fakeUnmount()
    const provider = fakeRender(() => PageContextProvider({ children: null }))
    const context = provider.props.value
    context.registerLayer('permission-window', layer)
    expect(context.getSnapshot()).toMatchObject({ path: '/admin/access-review', base: undefined, overlays: [] })
  })
})
