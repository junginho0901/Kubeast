import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { elementsOf, fakeRender, fakeUnmount, textsOf } from '@/testing/fakeHooks'

// "Connection successful" (or the failure line) of a model's Test stayed after the model, base URL, key variable or
// CA was edited, as if it were the answer for the values now in the form. The answer now goes with the values it
// tested, in AI Models' form and in the setup wizard's AI step.

vi.mock('react', async (importOriginal) => ({ ...(await importOriginal<typeof import('react')>()), ...(await import('@/testing/fakeHooks')).fakeHooks }))
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQuery: () => ({ data: undefined, isLoading: false, isFetching: false, error: null }),
  useMutation: () => ({ mutate: () => {}, reset: () => {}, isPending: false, error: null }),
  useQueryClient: () => ({ invalidateQueries: () => {} }),
}))
vi.mock('react-router-dom', () => ({ useNavigate: () => () => {} }))
vi.mock('@/hooks/useProviderAvailability', () => ({ useProviderAvailability: () => ({}) }))

import { api } from '@/services/api'
import { useModelForm } from './useModelForm'
import SetupAIModelPage from '../setup/SetupAIModelPage'

const OK = { success: true, message: 'Connection successful' }

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  fakeUnmount()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('AI Models: the Test answer', () => {
  async function tested() {
    vi.restoreAllMocks()
    const test = vi.spyOn(api, 'testModelConnection').mockResolvedValue(OK)
    const render = () => fakeRender(useModelForm)
    render().openCreateForm()
    await render().handleTest()
    expect(test).toHaveBeenCalledTimes(1)
    expect(render().testResult, 'the answer for the values tested').toEqual(OK)
    return render
  }

  it('stays while the tested values stay', async () => {
    const render = await tested()
    render().setFormName('renamed')
    expect(render().testResult).toEqual(OK)
  })

  it('goes once the model, base URL, key variable or CA is edited', async () => {
    const edits: [string, (form: ReturnType<typeof useModelForm>) => void][] = [
      ['model', (f) => f.setFormModel('gpt-4.1')],
      ['base URL', (f) => f.setFormBaseUrl('https://llm.example.com/v1')],
      ['key variable', (f) => f.setFormApiKeyEnv('OTHER_KEY')],
      ['CA', (f) => f.setFormCaCert('-----BEGIN CERTIFICATE-----')],
    ]
    for (const [what, edit] of edits) {
      fakeUnmount()
      const render = await tested()
      edit(render())
      expect(render().testResult, what).toBeNull()
    }
  })

  it('is not shown for values edited while the test ran', async () => {
    let answer = (_: typeof OK) => {}
    vi.spyOn(api, 'testModelConnection').mockReturnValue(new Promise((resolve) => { answer = resolve }))
    const render = () => fakeRender(useModelForm)
    render().openCreateForm()
    const running = render().handleTest()
    render().setFormModel('gpt-4.1')
    answer(OK)
    await running
    expect(render().testResult).toBeNull()
  })
})

describe('the setup wizard\'s AI step: the Test answer', () => {
  const tr = (_key: string, fallback: string) => fallback
  const page = () => fakeRender(() => SetupAIModelPage({ navigatingRef: { current: false }, tr }))
  const answerShown = (tree: unknown) => textsOf(tree).join(' ').includes(OK.message)

  async function tested() {
    vi.spyOn(api, 'testModelConnection').mockResolvedValue(OK)
    const button = elementsOf(page(), (p, type) => type === 'button' && textsOf(p.children).includes('Test Connection'))
    expect(button, 'the Test Connection button').toHaveLength(1)
    await (button[0].props.onClick as () => Promise<void>)()
    expect(answerShown(page()), 'the answer for the values tested').toBe(true)
  }

  it('stays while the tested values stay', async () => {
    await tested()
    expect(answerShown(page())).toBe(true)
  })

  it('goes once the key variable is edited', async () => {
    await tested()
    const keyField = elementsOf(page(), (p, type) => type === 'input' && p.value === 'OPENAI_API_KEY')
    expect(keyField, 'the key variable field').toHaveLength(1)
    ;(keyField[0].props.onChange as (e: { target: { value: string } }) => void)({ target: { value: 'OPENAI_KEY_2' } })
    expect(answerShown(page())).toBe(false)
  })
})
