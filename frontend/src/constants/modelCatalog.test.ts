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
