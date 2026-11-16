import { describe, expect, it } from 'vitest'
import en from '../i18n/locales/en.json'
import ko from '../i18n/locales/ko.json'
import { PROVIDER_CATALOG, getDefaultModel, getProvider } from './modelCatalog'

const lookup = (catalog: unknown, key: string) =>
  key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog)

describe('Azure OpenAI in the model catalog', () => {
  it('asks for the v1 endpoint and a deployment name, with no fixed model list', () => {
    const azure = getProvider('azure')!
    expect(azure.label).toBe('Azure OpenAI')
    expect(azure.baseUrlPlaceholder).toBe('https://<resource>.openai.azure.com/openai/v1/')
    expect(azure.models).toEqual([])
    expect(getDefaultModel('azure')).toBe('')
    expect(azure.modelHintKey).toBe('admin.aiModels.azureDeploymentHint')
    expect(azure.baseUrlHintKey).toBe('admin.aiModels.azureEndpointHint')
  })

  it('has every hint in English and Korean', () => {
    for (const p of PROVIDER_CATALOG) {
      for (const key of [p.modelHintKey, p.baseUrlHintKey].filter(Boolean) as string[]) {
        expect(lookup(en, key), `${p.id} en ${key}`).toEqual(expect.any(String))
        expect(lookup(ko, key), `${p.id} ko ${key}`).toEqual(expect.any(String))
      }
    }
  })
})

describe('OpenAI models in the catalog', () => {
  // developers.openai.com/api/docs/deprecations, read 2026-11-15: shut down 2026-10-23 (o4-mini, o3-mini, gpt-4.1-nano)
  // or on 2026-12-11 (gpt-5, gpt-5-mini, gpt-5-nano, o3); gpt-4o and gpt-4o-mini shut down 2027-01-14
  const ENDED_IN_2026 = ['o4-mini', 'o3-mini', 'gpt-4.1-nano', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'o3']
  const openai = getProvider('openai')!

  it('lists no model OpenAI shuts down in 2026, and the GPT-6 models that take tools in Chat Completions', () => {
    const names = openai.models.map((m) => m.name)
    expect(names.filter((n) => ENDED_IN_2026.includes(n))).toEqual([])
    expect(names).toEqual(expect.arrayContaining(['gpt-6-sol', 'gpt-6-luna']))
    // tools in the Responses API only (developers.openai.com/api/docs/guides/latest-model)
    expect(names.filter((n) => ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra'].includes(n))).toEqual([])
  })

  it('says deprecated in the open list for the models shutting down 2027-01-14', () => {
    const notes = Object.fromEntries(openai.models.map((m) => [m.name, m.note]))
    expect([notes['gpt-4o'], notes['gpt-4o-mini']]).toEqual(['deprecated', 'deprecated'])
    expect(notes['gpt-6-luna']).toBeUndefined()
  })
})

describe('default API key variables', () => {
  // ai-service model_config_policy.check_api_key_env: the built-in names or KUBEAST_AI_KEY_*; a default the server
  // refuses would make a new config of that provider fail to save (Azure's AZURE_API_KEY did)
  const BUILT_IN = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']
  it('are names the server takes', () => {
    for (const p of PROVIDER_CATALOG.filter((p) => p.defaultApiKeyEnv)) {
      expect(BUILT_IN.includes(p.defaultApiKeyEnv) || p.defaultApiKeyEnv.startsWith('KUBEAST_AI_KEY_'), `${p.id}: ${p.defaultApiKeyEnv}`).toBe(true)
    }
  })
})
