import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import i18next from 'i18next'
import en from '@/i18n/locales/en.json'
import ko from '@/i18n/locales/ko.json'
import { elementsOf, fakeRender, fakeUnmount, textsOf } from '@/testing/fakeHooks'

// Add with no team name sent nothing and only moved the focus to the field, with no word of why (WCAG 3.3.1): the
// reason is said under the field, as the API key window says its name's, and the field is marked with it.

const i18n = i18next.createInstance()
// addFailed: an earlier Add came back refused, which TanStack keeps on the mutation until its reset()
const ui = vi.hoisted(() => ({ lang: 'en', mutate: vi.fn(), addFailed: false, resets: 0 }))

vi.mock('react', async (importOriginal) => ({ ...(await importOriginal<typeof import('react')>()), ...(await import('@/testing/fakeHooks')).fakeHooks }))
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQuery: () => ({ data: [], error: null, errorUpdatedAt: 0, refetch: () => {} }),
  useMutation: (options: { mutationFn: unknown }) => {
    const adds = String(options.mutationFn).includes('adminCreateOrganization')
    const failed = adds && ui.addFailed
    return {
      mutate: ui.mutate,
      reset: () => {
        if (!adds) return
        ui.resets++
        ui.addFailed = false
      },
      isPending: false,
      isError: failed,
      variables: failed ? { type: 'team', name: 'ops' } : undefined,
      error: failed ? new Error('a team named ops exists') : null,
    }
  },
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
  ui.addFailed = false
  ui.resets = 0
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
const addFailures = (tree: unknown) => elementsOf(tree, (p) => p['data-testid'] === 'team-add-error')
const alerts = (tree: unknown) => elementsOf(tree, (p) => p.role === 'alert')
const enterName = (text: string) => (nameField(page()).onChange as (e: { target: { value: string } }) => void)({ target: { value: text } })
// presses Add (Enter in the field submits the same form); answers whether the name field was given the focus, through
// the ref the field itself holds, so the focus cannot land elsewhere
const pressAdd = () => {
  const tree = page()
  const focus = vi.fn()
  ;(nameField(tree).ref as { current: unknown }).current = { focus }
  const form = one(tree, (_p, t) => t === 'form', 'the add form')
  ;(form.onSubmit as (e: unknown) => void)({ preventDefault: () => {} })
  return focus.mock.calls.length > 0
}
const problemKey = () => (elementsOf(page(), (p) => p['data-testid'] === 'team-name-problem')[0] as unknown as { key: string | null }).key

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
    pressAdd()
    expect(textsOf(problems(page())).join('')).toBe('팀 이름을 입력하세요. 공백만으로는 이름이 되지 않습니다.')
  })

  // #955 review L1: the line followed what the field held, so typing spaces or deleting after Add changed it and a
  // screen reader read it again, while a second Add with the same reason said nothing
  it('says why as the field was at the press, and says it again at each press', () => {
    pressAdd()
    const first = problemKey()
    enterName('  ')
    expect(textsOf(problems(page())).join(''), 'typing spaces after Add').toBe('Enter a team name.')
    expect(problemKey(), 'the same line, not read again').toBe(first)
    enterName('')
    expect(textsOf(problems(page())).join(''), 'deleting them').toBe('Enter a team name.')
    expect(problemKey()).toBe(first)

    pressAdd()
    const second = problemKey()
    expect(textsOf(problems(page())).join(''), 'Add again, the field empty').toBe('Enter a team name.')
    expect(second, 'drawn anew, so read again').not.toBe(first)
    enterName(' ')
    pressAdd()
    expect(textsOf(problems(page())).join(''), 'Add with a space').toBe('Enter a team name: spaces alone are not one.')
    expect(problemKey()).not.toBe(second)
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

  it("an earlier Add's failure goes when Add is pressed with no name or a name is typed, so only the current reason shows", () => {
    ui.addFailed = true
    expect(addFailures(page()), 'the earlier failure shows').toHaveLength(1)
    pressAdd()
    let tree = page()
    expect(addFailures(tree), 'Add with no name').toHaveLength(0)
    expect(alerts(tree).map((a) => textsOf(a).join(''))).toEqual(['Enter a team name.'])

    // the field was emptied to spaces while the Add was on its way, and its failure came after
    enterName('   ')
    ui.addFailed = true
    pressAdd()
    tree = page()
    expect(addFailures(tree), 'Add with spaces only').toHaveLength(0)
    expect(alerts(tree).map((a) => textsOf(a).join(''))).toEqual(['Enter a team name: spaces alone are not one.'])

    ui.addFailed = true
    enterName('ops2')
    tree = page()
    expect(addFailures(tree), 'a name typed').toHaveLength(0)
    expect(alerts(tree)).toHaveLength(0)
  })

  it('leaves an Add that has not failed as it is when a name is typed or Add is pressed with none', () => {
    enterName('o')
    enterName('')
    pressAdd()
    expect(ui.resets).toBe(0)
  })
})

describe('Teams: the name field', () => {
  it('has a label naming it, in each language', () => {
    for (const [lang, text] of [['en', 'Team name'], ['ko', '팀 이름']] as const) {
      ui.lang = lang
      const tree = page()
      const id = nameField(tree).id
      expect(typeof id === 'string' && id !== '', `${lang}: the field has an id`).toBe(true)
      expect(elementsOf(tree, (p) => p.id === id), `${lang}: the id is the field's alone`).toHaveLength(1)
      const labels = elementsOf(tree, (p, type) => type === 'label' && p.htmlFor === id)
      expect(labels.map((l) => textsOf(l).join('')), `${lang}: the label for the field`).toEqual([text])
    }
  })

  // #955 review L6: the field and its reason had fixed ids; they are React's (useId), as ClusterNodeMap's hint is
  it("takes its id and its reason's id from useId", () => {
    pressAdd()
    const tree = page()
    const id = nameField(tree).id
    const [problem] = problems(tree)
    expect(id).toMatch(/^_r_\w+_$/)
    expect(problem.props.id).toMatch(/^_r_\w+_$/)
    expect(problem.props.id).not.toBe(id)
    expect(nameField(page()).id, 'the same id on the next render').toBe(id)
  })
})
