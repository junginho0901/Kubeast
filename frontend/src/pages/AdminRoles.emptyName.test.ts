import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import i18next from 'i18next'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import { elementsOf, fakeRender, fakeUnmount, textsOf } from '@/testing/fakeHooks'
import { modalButton } from '@/components/modalStyles'

// #955 review L5a: Save with no role name said "Role name is required" in the box at the window's foot, with no alert
// role, no tie to the field and the same words for spaces. It is said under the field as Teams says its name's.

const i18n = i18next.createInstance()
// every save comes back refused, which the page keeps as its form error
const ui = vi.hoisted(() => ({ lang: 'en', mutate: vi.fn() }))

vi.mock('react', async (importOriginal) => ({ ...(await importOriginal<typeof import('react')>()), ...(await import('@/testing/fakeHooks')).fakeHooks }))
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQuery: () => ({ data: [], isLoading: false, error: null, errorUpdatedAt: 0, refetch: () => {} }),
  useMutation: (options: { onError?: (err: unknown) => void }) => ({
    mutate: (vars: unknown) => {
      ui.mutate(vars)
      options.onError?.({ response: { data: { detail: 'refused by the server' } } })
    },
    isPending: false,
  }),
  useQueryClient: () => ({ invalidateQueries: () => {} }),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => i18n.getFixedT(ui.lang)(key, options as never) }),
}))
vi.mock('@/hooks/usePermission', () => ({ usePermission: () => ({ has: () => true, permissions: { '*': ['*'] } }) }))
vi.mock('@/hooks/useAdaptiveTable', () => ({
  useAdaptiveTable: () => ({ containerRef: { current: null }, bodyRef: { current: null }, theadRef: { current: null }, firstRowRef: { current: null }, rowsPerPage: 10 }),
}))
vi.mock('@/services/confirm', () => ({ useConfirm: () => async () => false }))

import AdminRoles from './AdminRoles'

beforeAll(async () => {
  await i18n.init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: en }, ko: { translation: ko } }, interpolation: { escapeValue: false } })
})
beforeEach(() => {
  ui.lang = 'en'
  ui.mutate.mockClear()
})
afterEach(() => fakeUnmount())

type Props = Record<string, unknown>
const page = () => fakeRender(() => AdminRoles())
const one = (tree: unknown, match: (p: Props, type: unknown) => boolean, what: string) => {
  const found = elementsOf(tree, match)
  expect(found, what).toHaveLength(1)
  return found[0].props
}
const nameField = (tree: unknown) => one(tree, (p, type) => type === 'input' && p.maxLength !== undefined, 'the name field')
const problems = (tree: unknown) => elementsOf(tree, (p) => p['data-testid'] === 'role-name-problem')
const reasonText = () => textsOf(problems(page())).join('')
const problemKey = () => (problems(page())[0] as unknown as { key: string | null }).key
const openCreate = () => {
  const create = one(page(), (p, type) => type === 'button' && textsOf(p.children).join('') === 'Create Role', 'Create Role')
  ;(create.onClick as () => void)()
}
const enterName = (text: string) => (nameField(page()).onChange as (e: { target: { value: string } }) => void)({ target: { value: text } })
// presses Create (the window's primary button); answers whether the name field was given the focus, through the ref
// the field itself holds
const pressCreate = () => {
  const tree = page()
  const focus = vi.fn()
  ;(nameField(tree).ref as { current: unknown }).current = { focus }
  const create = one(tree, (p, type) => type === 'button' && p.className === modalButton.primary, "the window's Create")
  ;(create.onClick as () => void)()
  return focus.mock.calls.length > 0
}

describe('Roles: Create with no name', () => {
  it('says under the field that a name is needed, marks the field with it and sends nothing', () => {
    openCreate()
    expect(problems(page()), 'before Create').toHaveLength(0)
    expect(nameField(page())['aria-invalid']).toBeUndefined()

    expect(pressCreate(), 'the focus goes to the field').toBe(true)
    expect(ui.mutate).not.toHaveBeenCalled()
    const tree = page()
    const [problem] = problems(tree)
    expect(problem?.props.role).toBe('alert')
    expect(textsOf(problem).join('')).toBe('Enter a role name.')
    const field = nameField(tree)
    expect(field['aria-invalid']).toBe(true)
    expect(field['aria-describedby']).toBe(problem.props.id)
    expect(textsOf(tree).join('\n'), 'not in the box at the foot').not.toContain('Role name is required')
  })

  it('says spaces alone are not a name, in each language', () => {
    openCreate()
    enterName('   ')
    pressCreate()
    expect(reasonText()).toBe('Enter a role name: spaces alone are not one.')
    ui.lang = 'ko'
    expect(reasonText()).toBe('역할 이름을 입력하세요. 공백만으로는 이름이 되지 않습니다.')
    enterName('')
    pressCreate()
    expect(reasonText()).toBe('역할 이름을 입력하세요.')
  })

  it('says why as the field was at the press, and says it again at each press', () => {
    openCreate()
    pressCreate()
    const first = problemKey()
    enterName(' ')
    expect(reasonText(), 'typing a space after Create').toBe('Enter a role name.')
    expect(problemKey()).toBe(first)
    pressCreate()
    expect(reasonText()).toBe('Enter a role name: spaces alone are not one.')
    expect(problemKey(), 'drawn anew, so read again').not.toBe(first)
  })

  it('the reason goes once a name is typed, and Create sends that name without its spaces', () => {
    openCreate()
    pressCreate()
    enterName(' ops ')
    expect(problems(page())).toHaveLength(0)
    expect(nameField(page())['aria-invalid']).toBeUndefined()
    expect(nameField(page())['aria-describedby']).toBeUndefined()
    expect(pressCreate(), 'no focus move for a name').toBe(false)
    expect(ui.mutate).toHaveBeenCalledWith(expect.objectContaining({ name: 'ops' }))
  })

  it("an earlier Create's failure goes when Create is pressed with no name, so only the current reason shows", () => {
    openCreate()
    enterName('ops')
    pressCreate()
    expect(textsOf(page()).join('\n'), 'the server refused it').toContain('refused by the server')
    enterName('')
    pressCreate()
    const tree = page()
    expect(textsOf(tree).join('\n')).not.toContain('refused by the server')
    expect(textsOf(problems(tree)).join('')).toBe('Enter a role name.')
  })

  it('leaves no reason behind when the window is closed and opened again', () => {
    openCreate()
    pressCreate()
    const close = one(page(), (p, type) => type === 'button' && p.className === modalButton.cancel, 'Cancel')
    ;(close.onClick as () => void)()
    openCreate()
    expect(problems(page())).toHaveLength(0)
  })
})

describe('Roles: the name field', () => {
  it('has a label naming it and ids from useId', () => {
    openCreate()
    pressCreate()
    const tree = page()
    const id = nameField(tree).id
    expect(id).toMatch(/^_r_\w+_$/)
    const labels = elementsOf(tree, (p, type) => type === 'label' && p.htmlFor === id)
    expect(labels.map((l) => textsOf(l).join(''))).toEqual(['Role Name'])
    expect(problems(tree)[0].props.id).toMatch(/^_r_\w+_$/)
    expect(problems(tree)[0].props.id).not.toBe(id)
  })
})
