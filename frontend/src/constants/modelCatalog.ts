/**
 * Shared AI Model Catalog
 *
 * Provider → supported models mapping.
 * Used by both Setup.tsx and AdminAIModels.tsx for the 2-tier dropdown.
 */

/* ── Model definition ── */
export interface ModelDef {
  /** Model identifier sent to the API (e.g. "gpt-4o-mini") */
  name: string
  /** Short display label shown in the dropdown */
  label?: string
  /** Does this model support function/tool calling? */
  functionCalling: boolean
}

/* ── Provider definition ── */
export interface ProviderDef {
  id: string
  label: string
  icon: string
  /** Models pre-populated in the dropdown */
  models: ModelDef[]
  /** Does this provider need an API key? */
  needsApiKey: boolean
  /** Does this provider require a base URL? */
  needsBaseUrl: boolean
  /** Placeholder for the base URL field */
  baseUrlPlaceholder?: string
  /** Default base URL filled in on selection */
  defaultBaseUrl?: string
  /** The env var key for resolving the API key at runtime */
  defaultApiKeyEnv: string
  /** Extra fields the provider needs (shown as additional form inputs) */
  extraFields?: ExtraFieldDef[]
}

export interface ExtraFieldDef {
  key: string
  label: string
  placeholder: string
  required: boolean
}

/* ═══════════════════════════════════════
   Provider catalog
   ═══════════════════════════════════════ */
export const PROVIDER_CATALOG: ProviderDef[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    icon: '🤖',
    needsApiKey: true,
    needsBaseUrl: false,
    defaultApiKeyEnv: 'OPENAI_API_KEY',
    models: [
      { name: 'gpt-4o-mini', functionCalling: true },
      { name: 'gpt-4o', functionCalling: true },
      { name: 'gpt-4-turbo', functionCalling: true },
      { name: 'gpt-4', functionCalling: true },
      { name: 'gpt-3.5-turbo', functionCalling: true },
      { name: 'gpt-5', functionCalling: true },
      { name: 'gpt-5-mini', functionCalling: true },
      { name: 'o4-mini', functionCalling: true },
    ],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    icon: '🧠',
    needsApiKey: true,
    needsBaseUrl: false,
    defaultApiKeyEnv: 'ANTHROPIC_API_KEY',
    models: [
      { name: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4 (recommended)', functionCalling: true },
      { name: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', functionCalling: true },
      { name: 'claude-opus-4-20250514', label: 'Claude Opus 4', functionCalling: true },
      { name: 'claude-opus-4-1-20250805', label: 'Claude Opus 4.1', functionCalling: true },
    ],
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    icon: '💎',
    needsApiKey: true,
    needsBaseUrl: false,
    defaultApiKeyEnv: 'GEMINI_API_KEY',
    models: [
      { name: 'gemini-2.0-flash', functionCalling: true },
      { name: 'gemini-2.0-flash-lite', functionCalling: true },
      { name: 'gemini-2.5-flash', functionCalling: true },
      { name: 'gemini-2.5-flash-lite', functionCalling: true },
      { name: 'gemini-2.5-pro', functionCalling: true },
    ],
  },
  {
    id: 'azure',
    label: 'Azure OpenAI',
    icon: '☁️',
    needsApiKey: true,
    needsBaseUrl: true,
    baseUrlPlaceholder: 'https://<resource>.openai.azure.com/openai/deployments/<deployment>',
    defaultApiKeyEnv: 'AZURE_API_KEY',
    extraFields: [
      { key: 'azure_api_version', label: 'API Version', placeholder: '2024-06-01', required: true },
    ],
    models: [
      { name: 'gpt-4o', functionCalling: true },
      { name: 'gpt-4o-mini', functionCalling: true },
      { name: 'gpt-4', functionCalling: true },
      { name: 'gpt-35-turbo', functionCalling: true },
    ],
  },
  {
    id: 'ollama',
    label: 'Ollama (Local)',
    icon: '🏠',
    needsApiKey: false,
    needsBaseUrl: true,
    defaultBaseUrl: 'http://localhost:11434',
    baseUrlPlaceholder: 'http://localhost:11434',
    defaultApiKeyEnv: '',
    models: [
      { name: 'llama3', functionCalling: false },
      { name: 'llama3:70b', functionCalling: false },
      { name: 'llama2', functionCalling: false },
      { name: 'mistral', functionCalling: false },
      { name: 'mixtral', functionCalling: false },
      { name: 'codellama', functionCalling: false },
      { name: 'qwen2', functionCalling: true },
      { name: 'deepseek-coder-v2', functionCalling: false },
    ],
  },
  {
    id: 'custom',
    label: 'Custom / Other',
    icon: '⚙️',
    needsApiKey: true,
    needsBaseUrl: true,
    baseUrlPlaceholder: 'https://api.example.com/v1',
    defaultApiKeyEnv: 'OPENAI_API_KEY',
    models: [],
  },
]

/* ═══════════════════════════════════════
   Helpers
   ═══════════════════════════════════════ */

/** Get the ProviderDef for a given provider id */
export const getProvider = (id: string): ProviderDef | undefined =>
  PROVIDER_CATALOG.find((p) => p.id === id)

/** Get the first model name for a provider (for default selection) */
export const getDefaultModel = (providerId: string): string => {
  const prov = getProvider(providerId)
  return prov?.models[0]?.name ?? ''
}

/** Get the label for a model, falling back to the model name */
export const getModelLabel = (providerId: string, modelName: string): string => {
  const prov = getProvider(providerId)
  const m = prov?.models.find((m) => m.name === modelName)
  return m?.label ?? modelName
}
