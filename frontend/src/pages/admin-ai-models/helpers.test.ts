import { describe, expect, it } from 'vitest'
import { getProvider } from '@/constants/modelCatalog'
import { modelOptions } from './helpers'

describe('modelOptions', () => {
  const ollama = getProvider('ollama')!

  it('uses the built-in list when the provider listed nothing', () => {
    expect(modelOptions(ollama, []).map((o) => o.value)).toEqual(ollama.models.map((m) => m.name))
    expect(modelOptions(ollama).find((o) => o.value === 'gemma2')?.hint).toBe('no tools')
  })

  it('uses the provider list, with built-in labels and tool hints where it knows the model', () => {
    const opts = modelOptions(ollama, [{ name: 'granite4.1:8b' }, { name: 'gemma2' }, { name: 'qwen2.5' }])
    expect(opts.map((o) => o.value)).toEqual(['granite4.1:8b', 'gemma2', 'qwen2.5'])
    expect(opts[0]).toEqual({ value: 'granite4.1:8b', label: 'granite4.1:8b', hint: undefined, testId: 'model-option-granite4.1:8b' })
    expect(opts[1].hint).toBe('no tools')
    expect(opts[2].label).toBe('qwen2.5 (7b, tools)')
    expect(modelOptions(getProvider('anthropic')!, [{ name: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' }])[0].label).toBe('Claude Haiku 5.5')
  })
})
