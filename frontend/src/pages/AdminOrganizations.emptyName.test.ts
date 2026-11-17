import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import i18next from 'i18next'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import { elementsOf, fakeRender, fakeUnmount, textsOf } from '@/testing/fakeHooks'

// Add with no team name sent nothing and only moved the focus to the field, with no word of why (WCAG 3.3.1): the
// reason is said under the field, as the API key window says its name's, and the field is marked with it.

const i18n = i18next.createInstance()
const ui = vi.hoisted(() => ({ lang: 'en', mutate: vi.fn() }))

vi.mock('react', async (importOriginal) => ({ ...(await importOriginal<typeof import('react')>()), ...(await import('@/testing/fakeHooks')).fakeHooks }))
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQuery: () => ({ data: [], error: null, errorUpdatedAt: 0, refetch: () => {} }),
  useMutation: () => ({ mutate: ui.mutate, isPending: false, isError: false, variables: undefined, error: null }),
  useQueryClient: () => ({ invalidateQueries: () => {} }),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => i18n.getFixedT(ui.lang)(key, options as never) }),
}))
vi.mock('@/hooks/usePermission', () => ({ usePermission: () => ({ has: () => true }) }))
vi.mock('@/hooks/useAdaptiveTable', () => ({
  useAdaptiveTable: () => ({ containerRef: { current: null }, bodyRef: { current: null }, theadRef: { current: null }, firstRowRef: { current: null }, rowsPerPage: 10 }),
}))
vi.mock('@/services/confirm', () => ({ useConfirm: () => async () => false }))

import AdminOrganizations from './AdminOrganizations'

beforeAll(async () => {
  await i18n.init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false } })
})
beforeEach(() => {
  ui.lang = 'en'
  ui.mutate.mockClear()
})
afterEach(() => fakeUnmount())

type Props = Record<string, unknown>
const page = () => fakeRender(() => AdminOrganizations())
const one = (tree: unknown, match: (p: Props, type: unknown) => boolean, what: string) => {
  const found = elementsOf(tree, match)
  expect(found, what).toHaveLength(1)
  return found[0].props
}
const nameField = (tree: unknown) => one(tree, (p, type) => type === 'input' && p.maxLength !== undefined, 'the name field')
const problems = (tree: unknown) => elementsOf(tree, (p) => p['data-testid'] === 'team-name-problem')
const enterName = (text: string) => (nameField(page()).onChange as (e: { target: { value: string } }) => void)({ target: { value: text } })
// presses Add (Enter in the field submits the same form); answers whether the field was given the focus
const pressAdd = () => {
  const focus = vi.fn()
  const form = one(page(), (_p, t) => t === 'form', 'the add form')
  ;(form.onSubmit as (e: unknown) => void)({ preventDefault: () => {}, currentTarget: { querySelector: () => ({ focus }) } })
  return focus.mock.calls.length > 0
}

describe('Teams: Add with no name', () => {
  it('says under the field that a name is needed, marks the field with it and sends nothing', () => {
    expect(problems(page()), 'before Add').toHaveLength(0)
    expect(nameField(page())['aria-invalid']).toBeUndefined()

    expect(pressAdd(), 'the focus goes to the field').toBe(true)
    expect(ui.mutate).not.toHaveBeenCalled()
    const tree = page()
    const [problem] = problems(tree)
    expect(problem?.props.role).toBe('alert')
    expect(textsOf(problem).join('')).toBe('Enter a team name.')
    const field = nameField(tree)
    expect(field['aria-invalid']).toBe(true)
    expect(field['aria-describedby']).toBe(problem.props.id)
  })

  it('says spaces alone are not a name', () => {
    enterName('   ')
    expect(pressAdd()).toBe(true)
    expect(ui.mutate).not.toHaveBeenCalled()
    expect(textsOf(problems(page())).join('')).toBe('Enter a team name: spaces alone are not one.')
  })

  it('in Korean', () => {
    ui.lang = 'ko'
    pressAdd()
    expect(textsOf(problems(page())).join('')).toBe('팀 이름을 입력하세요.')
    enterName(' ')
    expect(textsOf(problems(page())).join('')).toBe('팀 이름을 입력하세요. 공백만으로는 이름이 되지 않습니다.')
  })

  it('the reason goes once a name is typed, and Add sends that name without its spaces', () => {
    pressAdd()
    enterName(' ')
    expect(problems(page()), 'spaces are still no name').toHaveLength(1)
    enterName(' platform ')
    expect(problems(page())).toHaveLength(0)
    expect(nameField(page())['aria-invalid']).toBeUndefined()
    expect(nameField(page())['aria-describedby']).toBeUndefined()

    expect(pressAdd(), 'no focus move for a name').toBe(false)
    expect(ui.mutate).toHaveBeenCalledWith({ type: 'team', name: 'platform' })
    expect(problems(page())).toHaveLength(0)
  })
})
