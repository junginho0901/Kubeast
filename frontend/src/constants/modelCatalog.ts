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
  /** A word or two shown after the label in the open list only (recommended, legacy …), so the closed field fits */
  note?: string
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
  /** i18n key of a line under the base URL field (the form a narrow field cuts off) */
  baseUrlHintKey?: string
  /** Default base URL filled in on selection */
  defaultBaseUrl?: string
  /** The env var key for resolving the API key at runtime */
  defaultApiKeyEnv: string
  /** Placeholder for the model field when the provider has no list (a name the user picks, e.g. an Azure deployment) */
  modelPlaceholder?: string
  /** i18n key of a line under the model field (what the provider calls the model) */
  modelHintKey?: string
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
      { name: 'gpt-5.5', functionCalling: true },
      { name: 'gpt-5.4', functionCalling: true },
      { name: 'gpt-5.4-mini', functionCalling: true },
      { name: 'gpt-5', functionCalling: true },
      { name: 'gpt-5-mini', functionCalling: true },
      { name: 'gpt-4o', functionCalling: true },
      { name: 'gpt-4o-mini', functionCalling: true },
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
      { name: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'recommended', functionCalling: true },
      { name: 'claude-opus-5-5', label: 'Claude Opus 5.5', functionCalling: true },
      { name: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', note: 'lowest cost', functionCalling: true },
      { name: 'claude-fable-5-1', label: 'Claude Fable 5.1', note: 'most capable', functionCalling: true },
      { name: 'claude-opus-5', label: 'Claude Opus 5', functionCalling: true },
      { name: 'claude-sonnet-5', label: 'Claude Sonnet 5', functionCalling: true },
      { name: 'claude-fable-5', label: 'Claude Fable 5', functionCalling: true },
      { name: 'claude-opus-4-8', label: 'Claude Opus 4.8', functionCalling: true },
      { name: 'claude-opus-4-7', label: 'Claude Opus 4.7', functionCalling: true },
      { name: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', functionCalling: true },
      { name: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', functionCalling: true },
    ],
  },
  {
    // A Claude Pro/Max subscription's `claude setup-token` value through Claude Code (personal use only)
    id: 'claude-code',
    label: 'Claude subscription',
    icon: '🔑',
    needsApiKey: true,
    needsBaseUrl: false,
    defaultApiKeyEnv: 'CLAUDE_CODE_OAUTH_TOKEN',
    models: [
      { name: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'recommended', functionCalling: true },
      { name: 'claude-opus-5-5', label: 'Claude Opus 5.5', functionCalling: true },
      { name: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', note: 'uses the least', functionCalling: true },
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
      { name: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', functionCalling: true },
      { name: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', functionCalling: true },
      { name: 'gemini-3-flash', label: 'Gemini 3 Flash', functionCalling: true },
      { name: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite', functionCalling: true },
      { name: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', note: 'legacy', functionCalling: true },
    ],
  },
  {
    id: 'azure',
    label: 'Azure OpenAI',
    icon: '☁️',
    needsApiKey: true,
    needsBaseUrl: true,
    // The v1 API (OpenAI-compatible, no api-version); the model is the deployment name, which each resource names itself.
    baseUrlPlaceholder: 'https://<resource>.openai.azure.com/openai/v1/',
    baseUrlHintKey: 'admin.aiModels.azureEndpointHint',
    // ai-service takes KUBEAST_AI_KEY_* for keys beyond the three built-in names (model_config_policy)
    defaultApiKeyEnv: 'KUBEAST_AI_KEY_AZURE',
    modelPlaceholder: 'my-gpt-deployment',
    modelHintKey: 'admin.aiModels.azureDeploymentHint',
    models: [],
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
      { name: 'qwen2.5', label: 'qwen2.5', note: '7b, tools', functionCalling: true },
      { name: 'qwen2.5:14b', label: 'qwen2.5:14b', note: '14b, tools', functionCalling: true },
      { name: 'llama3.3', functionCalling: true },
      { name: 'llama3.1', functionCalling: true },
      { name: 'llama3.2', functionCalling: true },
      { name: 'qwen2.5-coder', functionCalling: true },
      { name: 'mistral-nemo', functionCalling: true },
      { name: 'mistral', functionCalling: true },
      { name: 'gemma2', functionCalling: false },
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
