import { useMemo, useState, type MutableRefObject } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '@/services/api'
import { AlertCircle, Bot, Check, Loader2, Zap } from 'lucide-react'
import {
  PROVIDER_CATALOG,
  getProvider,
  type ProviderDef,
} from '@/constants/modelCatalog'
import CustomDropdown, { type DropdownOption } from '@/components/CustomDropdown'

interface SetupAIModelPageProps {
  navigatingRef: MutableRefObject<boolean>
  tr: (key: string, fallback: string) => string
}

export default function SetupAIModelPage({ navigatingRef, tr }: SetupAIModelPageProps) {
  const navigate = useNavigate()

  const [selectedProvider, setSelectedProvider] = useState('openai')
  const [aiModel, setAiModel] = useState('gpt-4o-mini')
  const [aiCustomModel, setAiCustomModel] = useState(false) // true = free text input
  const [aiApiKey, setAiApiKey] = useState('')
  const [aiBaseUrl, setAiBaseUrl] = useState('')
  const [aiTesting, setAiTesting] = useState(false)
  const [aiTestResult, setAiTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [aiSaving, setAiSaving] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)

  const handleProviderChange = (providerId: string) => {
    setSelectedProvider(providerId)
    const prov = getProvider(providerId)
    if (prov) {
      setAiModel(prov.models[0]?.name ?? '')
      setAiCustomModel(false)
      setAiBaseUrl(prov.defaultBaseUrl ?? '')
      setAiTestResult(null)
      setAiError(null)
    }
  }

  const currentProviderDef: ProviderDef = getProvider(selectedProvider) ?? PROVIDER_CATALOG[0]

  const modelDropdownOptions: DropdownOption[] = useMemo(
    () =>
      currentProviderDef.models.map((m) => ({
        value: m.name,
        label: m.label ?? m.name,
        hint: !m.functionCalling ? 'no tools' : undefined,
      })),
    [currentProviderDef],
  )

  const handleTestConnection = async () => {
    setAiTesting(true)
    setAiTestResult(null)
    setAiError(null)
    try {
      const baseUrl = aiBaseUrl.trim() || undefined
      const result = await api.testModelConnection({
        provider: selectedProvider,
        model: aiModel,
        base_url: baseUrl,
        api_key: aiApiKey || (currentProviderDef.needsApiKey ? '' : 'not-needed'),
        tls_verify: true,
      })
      setAiTestResult(result)
    } catch (e: any) {
      setAiTestResult({ success: false, message: e?.message || 'Connection failed' })
    } finally {
      setAiTesting(false)
    }
  }

  const handleSaveModel = async () => {
    setAiSaving(true)
    setAiError(null)
    try {
      // Create model config in DB — Setup 전용 공개 API 사용 (로그인 전)
      await api.createModelConfigSetup({
        name: `${selectedProvider}-setup`,
        provider: selectedProvider,
        model: aiModel,
        base_url: aiBaseUrl.trim() || undefined,
        api_key: aiApiKey.trim() || undefined,
        tls_verify: true,
        enabled: true,
        is_default: true,
      })

      // Navigate to login
      navigatingRef.current = true
      setTimeout(() => {
        navigate('/login', { replace: true })
      }, 400)
    } catch (e: any) {
      const detail = e?.response?.data?.detail
      setAiError(detail || e?.message || 'Failed to save model configuration')
    } finally {
      setAiSaving(false)
    }
  }

  const handleSkipAi = () => {
    navigatingRef.current = true
    navigate('/login', { replace: true })
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-8">
      {/* header */}
      <div className="space-y-2">
        <div className="inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900/40 px-3 py-1 text-xs text-slate-300">
          <Bot className="h-3.5 w-3.5 text-primary-400" />
          {tr('setup.ai.badge', 'AI Configuration')}
        </div>
        <h1 className="text-3xl font-semibold">
          {tr('setup.ai.title', 'Configure AI Model')}
        </h1>
        <p className="text-sm text-slate-400">
          {tr('setup.ai.subtitle', 'Select an LLM provider for the AI assistant. You can change this later.')}
        </p>
      </div>

      {/* provider grid */}
      <div className="grid gap-3 sm:grid-cols-3">
        {PROVIDER_CATALOG.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => handleProviderChange(p.id)}
            className={`rounded-2xl border px-4 py-4 text-left transition ${
              selectedProvider === p.id
                ? 'border-primary-500/60 bg-primary-500/10'
                : 'border-slate-800 bg-slate-900/40 hover:border-slate-700'
            }`}
          >
            <div className="flex items-center gap-2 text-sm font-semibold">
              <span className="text-lg">{p.icon}</span>
              {p.label}
            </div>
          </button>
        ))}
      </div>

      {/* model config fields */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5 space-y-4">
        {/* model selector — 2-tier dropdown */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs font-semibold text-slate-300">
              {tr('setup.ai.model', 'Model')}
            </label>
            {currentProviderDef.models.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setAiCustomModel(!aiCustomModel)
                  if (aiCustomModel && currentProviderDef.models.length > 0) {
                    setAiModel(currentProviderDef.models[0].name)
                  }
                }}
                className="text-[10px] text-slate-500 hover:text-primary-400 transition"
              >
                {aiCustomModel ? '← Select from list' : 'Custom model name →'}
              </button>
            )}
          </div>
          {!aiCustomModel && currentProviderDef.models.length > 0 ? (
            <CustomDropdown
              options={modelDropdownOptions}
              value={aiModel}
              onChange={setAiModel}
              placeholder="Select model"
            />
          ) : (
            <input
              type="text"
              value={aiModel}
              onChange={(e) => setAiModel(e.target.value)}
              placeholder="e.g. gpt-4o-mini"
              className="w-full rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-600"
            />
          )}
        </div>

        {/* tool calling warning */}
        {(() => {
          const md = currentProviderDef.models.find((m) => m.name === aiModel)
          if (md && !md.functionCalling) {
            return (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300 flex items-center gap-2">
                <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
                {tr('setup.ai.noToolCalling', 'This model does not support tool/function calling. AI assistant features may be limited.')}
              </div>
            )
          }
          return null
        })()}

        {/* API Key */}
        {currentProviderDef.needsApiKey && (
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">
              {tr('setup.ai.apiKey', 'API Key')}
            </label>
            <input
              type="password"
              value={aiApiKey}
              onChange={(e) => setAiApiKey(e.target.value)}
              placeholder="sk-..."
              className="w-full rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-600"
            />
            <p className="mt-1 text-xs text-slate-500">
              {tr('setup.ai.apiKeyHint', 'Your API key will be stored securely as a Kubernetes Secret.')}
            </p>
          </div>
        )}

        {/* Base URL */}
        {currentProviderDef.needsBaseUrl && (
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">
              {tr('setup.ai.baseUrl', 'Base URL')}
            </label>
            <input
              type="text"
              value={aiBaseUrl}
              onChange={(e) => setAiBaseUrl(e.target.value)}
              placeholder={currentProviderDef.baseUrlPlaceholder || 'https://api.example.com/v1'}
              className="w-full rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-600"
            />
          </div>
        )}

        {/* Test connection */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleTestConnection}
            disabled={aiTesting || !aiModel}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-slate-600 disabled:opacity-50"
          >
            {aiTesting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Zap className="h-3.5 w-3.5 text-yellow-400" />
            )}
            {tr('setup.ai.test', 'Test Connection')}
          </button>

          {aiTestResult && (
            <span
              className={`text-xs font-medium ${
                aiTestResult.success ? 'text-emerald-400' : 'text-red-400'
              }`}
            >
              {aiTestResult.success ? (
                <span className="flex items-center gap-1">
                  <Check className="h-3.5 w-3.5" />
                  {aiTestResult.message}
                </span>
              ) : (
                <span className="flex items-center gap-1">
                  <AlertCircle className="h-3.5 w-3.5" />
                  {aiTestResult.message}
                </span>
              )}
            </span>
          )}
        </div>
      </div>

      {/* error */}
      {aiError && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {aiError}
        </div>
      )}

      {/* actions */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={handleSkipAi}
          className="text-xs text-slate-500 hover:text-slate-300 transition"
        >
          {tr('setup.ai.skip', 'Skip — use defaults')}
        </button>

        <button
          type="button"
          onClick={handleSaveModel}
          disabled={aiSaving || !aiModel}
          className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {aiSaving ? (
            <span className="flex items-center gap-1.5">
              <Loader2 className="h-4 w-4 animate-spin" />
              {tr('setup.ai.saving', 'Saving...')}
            </span>
          ) : (
            tr('setup.ai.save', 'Save & Continue')
          )}
        </button>
      </div>
    </div>
  )
}
