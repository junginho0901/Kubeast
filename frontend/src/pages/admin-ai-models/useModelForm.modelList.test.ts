import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeRender, fakeUnmount } from '@/testing/fakeHooks'

// Typing the API key variable's name in Add Model asked the provider's model list once a letter (34 letters typed,
// 35 requests), where the Base URL and CA fields wait 500 ms after the last key. The name waits with them now; a
// provider picked or a saved model opened still asks at once, with its own key variable.

const query = vi.hoisted(() => ({ asked: new Set<string>(), answers: new Map<string, unknown>() }))

vi.mock('react', async (importOriginal) => ({ ...(await importOriginal<typeof import('react')>()), ...(await import('@/testing/fakeHooks')).fakeHooks }))
// TanStack Query as this hook uses it: an enabled key asks once, and an answer is drawn only for the key it was asked for
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQuery: ({ queryKey, queryFn, enabled }: { queryKey: unknown[]; queryFn: () => Promise<unknown>; enabled?: boolean }) => {
    const key = JSON.stringify(queryKey)
    if (queryKey[0] === 'provider-models' && enabled !== false && !query.asked.has(key)) {
      query.asked.add(key)
      void queryFn().then((data) => query.answers.set(key, data))
    }
    return { data: query.answers.get(key), isLoading: false, isFetching: false, error: null }
  },
  useMutation: () => ({ mutate: () => {}, reset: () => {}, isPending: false, error: null }),
  useQueryClient: () => ({ invalidateQueries: () => {} }),
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, o?: { defaultValue?: string }) => o?.defaultValue ?? key }) }))

import { api, type ModelConfigResponse } from '@/services/api'
import { useModelForm } from './useModelForm'

type ModelList = Awaited<ReturnType<typeof api.listProviderModels>>

const render = () => fakeRender(useModelForm)
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  query.asked.clear()
  query.answers.clear()
})
afterEach(() => {
  fakeUnmount()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// Opens Add Model and lets its first ask go; returns the model list call, cleared
function opened() {
  const list = vi.spyOn(api, 'listProviderModels').mockResolvedValue({ models: [] })
  render().openCreateForm()
  render()
  vi.advanceTimersByTime(500)
  render()
  expect(list.mock.calls.map(([p]) => p.api_key_env), 'Add Model asks once, with the default key variable').toEqual(['OPENAI_API_KEY'])
  list.mockClear()
  return list
}

// Empties the key variable field and types `text` a letter at a time, 50 ms apart
function typeKeyName(text: string) {
  render().setFormApiKeyEnv('')
  render()
  for (let i = 1; i <= text.length; i++) {
    vi.advanceTimersByTime(50)
    render().setFormApiKeyEnv(text.slice(0, i))
    expect(render().formApiKeyEnv, 'the field shows each letter at once').toBe(text.slice(0, i))
  }
}

describe('AI Models: the provider model list while the key variable is typed', () => {
  it('is asked once, 500 ms after the last letter, and not once a letter', () => {
    const list = opened()
    const name = 'KUBEAST_AI_KEY_TEAM_A_PRODUCTION_1'
    expect(name).toHaveLength(34)
    typeKeyName(name)
    expect(list, 'nothing asked while typing').not.toHaveBeenCalled()
    vi.advanceTimersByTime(499)
    render()
    expect(list, 'nothing asked before 500 ms').not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    render()
    expect(list.mock.calls.map(([p]) => p.api_key_env)).toEqual([name])
  })

  it('draws the answer for the name in the field, not an answer that came later for a name typed before', async () => {
    const list = opened()
    const waiting: ((answer: ModelList) => void)[] = []
    list.mockImplementation(() => new Promise<ModelList>((resolve) => waiting.push(resolve)))
    typeKeyName('KUBEAST_AI_KEY_A')
    vi.advanceTimersByTime(500)
    render()
    typeKeyName('KUBEAST_AI_KEY_B')
    vi.advanceTimersByTime(500)
    render()
    expect(list.mock.calls.map(([p]) => p.api_key_env)).toEqual(['KUBEAST_AI_KEY_A', 'KUBEAST_AI_KEY_B'])

    waiting[1]({ models: [{ name: 'model-of-b' }] })
    await settle()
    waiting[0]({ models: [{ name: 'model-of-a-1' }, { name: 'model-of-a-2' }] })
    await settle()
    const form = render()
    expect(form.modelList.count, 'the list of KUBEAST_AI_KEY_B').toBe(1)
    expect(form.currentModelOptions.map((o) => o.value)).toEqual(['model-of-b'])
    expect(form.formModel).toBe('model-of-b')
  })

  it('is asked at once with the key variable of a provider picked or a model opened, never with the one before', () => {
    const list = opened()
    const asked = () => list.mock.calls.map(([p]) => [p.provider, p.api_key_env])

    render().handleProviderChange('anthropic')
    render()
    expect(asked()).toEqual([['anthropic', 'ANTHROPIC_API_KEY']])
    vi.advanceTimersByTime(500)
    render()
    expect(asked(), 'nothing more once the wait ends').toEqual([['anthropic', 'ANTHROPIC_API_KEY']])

    list.mockClear()
    const saved: ModelConfigResponse = {
      id: 7, name: 'gemini', provider: 'gemini', model: 'gemini-x', base_url: null, api_key_env: 'KUBEAST_AI_KEY_GEMINI',
      api_key_secret_name: null, api_key_secret_key: null, extra_headers: {}, tls_verify: true, ca_cert: null, options: null,
      enabled: true, is_default: false, tier: 'default', created_at: '', updated_at: '',
    }
    render().openEditForm(saved)
    render()
    expect(asked()).toEqual([['gemini', 'KUBEAST_AI_KEY_GEMINI']])
    vi.advanceTimersByTime(500)
    render()
    expect(asked(), 'nothing more once the wait ends').toEqual([['gemini', 'KUBEAST_AI_KEY_GEMINI']])
  })
})
