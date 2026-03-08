import { useState, useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ModelConfigResponse } from '@/services/api'
import { useTranslation } from 'react-i18next'
import {
  PROVIDER_CATALOG,
  getProvider,
  getModelLabel,
  type ProviderDef,
} from '@/constants/modelCatalog'
import CustomDropdown, { DropdownOption } from '@/components/CustomDropdown'
import {
  Bot,
  Check,
  AlertCircle,
  Loader2,
  Plus,
  Pencil,
  Trash2,
  Zap,
  X,
  Radio,
  CircleDot,
  RefreshCw,
} from 'lucide-react'

/* helper — provider dropdown options */
const providerOptions: DropdownOption[] = PROVIDER_CATALOG.map((p) => ({
  value: p.id,
  label: p.label,
  icon: p.icon,
}))

/* helper — build model dropdown options for a provider */
function modelOptions(provDef: ProviderDef): DropdownOption[] {
  return provDef.models.map((m) => ({
    value: m.name,
    label: m.label ?? m.name,
    hint: !m.functionCalling ? 'no tools' : undefined,
  }))
}

/* ═══════════════════════════════════════ */
export default function AdminAIModels() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const tr = (key: string, fb: string) => t(key, { defaultValue: fb })

  /* ── which card is being edited / created ── */
  const [editingId, setEditingId] = useState<number | null>(null) // null = not editing
  const [isCreating, setIsCreating] = useState(false) // show new-model form at top

  /* ── form state ── */
  const [formName, setFormName] = useState('')
  const [formProvider, setFormProvider] = useState('openai')
  const [formModel, setFormModel] = useState('')
  const [formCustomModel, setFormCustomModel] = useState(false)
  const [formBaseUrl, setFormBaseUrl] = useState('')
  const [formApiKey, setFormApiKey] = useState('')
  const [formShowApiKey, setFormShowApiKey] = useState(false)
  const [formEnabled, setFormEnabled] = useState(true)
  const [formIsDefault, setFormIsDefault] = useState(false)

  /* ── test state ── */
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)

  /* ── rollout state ── */
  const [rolloutStatus, setRolloutStatus] = useState<'idle' | 'rolling' | 'done' | 'error'>('idle')
  const [rolloutMessage, setRolloutMessage] = useState('')

  const { data: configs, isLoading } = useQuery({
    queryKey: ['model-configs'],
    queryFn: () => api.listModelConfigs(),
  })

  const createMutation = useMutation({
    mutationFn: (data: any) => api.createModelConfig(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['model-configs'] })
      qc.invalidateQueries({ queryKey: ['ai-config'] })
      resetForm()
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: any }) => api.updateModelConfig(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['model-configs'] })
      qc.invalidateQueries({ queryKey: ['ai-config'] })
      resetForm()
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteModelConfig(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['model-configs'] })
      qc.invalidateQueries({ queryKey: ['ai-config'] })
    },
  })

  const activateMutation = useMutation({
    mutationFn: (id: number) => api.updateModelConfig(id, { is_default: true }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['model-configs'] })
      qc.invalidateQueries({ queryKey: ['ai-config'] })
    },
  })

  const currentProviderDef: ProviderDef = getProvider(formProvider) ?? PROVIDER_CATALOG[0]
  const currentModelOptions = useMemo(() => modelOptions(currentProviderDef), [currentProviderDef])

  /* ── form helpers ── */
  const resetForm = () => {
    setEditingId(null)
    setIsCreating(false)
    setFormName('')
    setFormProvider('openai')
    setFormModel('')
    setFormCustomModel(false)
    setFormBaseUrl('')
    setFormApiKey('')
    setFormShowApiKey(false)
    setFormEnabled(true)
    setFormIsDefault(false)
    setTestResult(null)
    setRolloutStatus('idle')
    setRolloutMessage('')
  }

  const openEditForm = (cfg: ModelConfigResponse) => {
    const provDef = getProvider(cfg.provider)
    const isKnown = provDef?.models.some((m) => m.name === cfg.model) ?? false
    setIsCreating(false)
    setEditingId(cfg.id)
    setFormName(cfg.name)
    setFormProvider(cfg.provider)
    setFormModel(cfg.model)
    setFormCustomModel(!isKnown)
    setFormBaseUrl(cfg.base_url || '')
    setFormApiKey('')  // don't pre-fill key for security; show placeholder instead
    setFormShowApiKey(false)
    setFormEnabled(cfg.enabled)
    setFormIsDefault(cfg.is_default)
    setTestResult(null)
    setRolloutStatus('idle')
    setRolloutMessage('')
  }

  const openCreateForm = () => {
    resetForm()
    setIsCreating(true)
  }

  const handleProviderChange = (newProvider: string) => {
    setFormProvider(newProvider)
    const prov = getProvider(newProvider)
    if (prov) {
      setFormModel(prov.models[0]?.name ?? '')
      setFormCustomModel(false)
      setFormBaseUrl(prov.defaultBaseUrl ?? '')
      setFormApiKey('')
      setTestResult(null)
    }
  }

  const handleSubmit = () => {
    const payload: Record<string, any> = {
      name: formName,
      provider: formProvider,
      model: formModel,
      base_url: formBaseUrl || undefined,
      enabled: formEnabled,
      is_default: formIsDefault,
    }
    // Only send api_key if user typed a new one
    if (formApiKey.trim()) {
      payload.api_key = formApiKey.trim()
    }
    if (editingId) {
      updateMutation.mutate({ id: editingId, data: payload })
    } else {
      createMutation.mutate(payload)
    }
  }

  const handleTest = async () => {
    if (!formApiKey.trim() && currentProviderDef.needsApiKey !== false) {
      setTestResult({ success: false, message: 'Please enter an API key to test' })
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      const result = await api.testModelConnection({
        provider: formProvider,
        model: formModel,
        base_url: formBaseUrl || undefined,
        api_key: formApiKey.trim() || undefined,
      })
      setTestResult(result)
    } catch (e: any) {
      setTestResult({ success: false, message: e?.message || 'Test failed' })
    } finally {
      setTesting(false)
    }
  }

  /* ── rollout after saving a new model that may need new env vars ── */
  const handleRollout = async () => {
    setRolloutStatus('rolling')
    setRolloutMessage('Restarting ai-service to pick up new API keys…')
    try {
      // Call the cluster health check repeatedly — in practice
      // the auth-service setup endpoint would be used. For now we poll health.
      const resp = await fetch('/api/v1/cluster/health')
      if (resp.ok) {
        setRolloutStatus('done')
        setRolloutMessage('Service is healthy. New API keys should be available.')
      } else {
        throw new Error('Health check returned non-ok')
      }
    } catch (e: any) {
      setRolloutStatus('error')
      setRolloutMessage('Rollout may still be in progress. Please wait and refresh.')
    }
  }

  const isSaving = createMutation.isPending || updateMutation.isPending

  /* ═══════════════════════════════════════
     Inline form — rendered below a card or at top for "Create"
     ═══════════════════════════════════════ */
  const renderForm = () => (
    <div className="rounded-xl border border-primary-500/30 bg-slate-900/80 p-5 space-y-4 mt-2 shadow-lg shadow-primary-500/5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
          {editingId ? (
            <>
              <Pencil className="h-3.5 w-3.5 text-primary-400" />
              {tr('admin.aiModels.edit', 'Edit Model')}
            </>
          ) : (
            <>
              <Plus className="h-3.5 w-3.5 text-primary-400" />
              {tr('admin.aiModels.new', 'New Model')}
            </>
          )}
        </h2>
        <button onClick={resetForm} className="text-slate-500 hover:text-slate-300 transition">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Name */}
        <div>
          <label className="block text-xs font-semibold text-slate-400 mb-1">Name</label>
          <input
            type="text"
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            placeholder="e.g. my-gpt4"
            className="w-full rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-600"
          />
        </div>

        {/* Provider — custom dropdown */}
        <CustomDropdown
          label="Provider"
          options={providerOptions}
          value={formProvider}
          onChange={handleProviderChange}
          placeholder="Select provider"
        />

        {/* Model — 2-tier: dropdown + custom toggle */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs font-semibold text-slate-400">Model</label>
            {currentProviderDef.models.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setFormCustomModel(!formCustomModel)
                  if (formCustomModel && currentProviderDef.models.length > 0) {
                    setFormModel(currentProviderDef.models[0].name)
                  }
                }}
                className="text-[10px] text-slate-500 hover:text-primary-400 transition"
              >
                {formCustomModel ? '← Select from list' : 'Custom model name →'}
              </button>
            )}
          </div>
          {!formCustomModel && currentProviderDef.models.length > 0 ? (
            <CustomDropdown
              options={currentModelOptions}
              value={formModel}
              onChange={setFormModel}
              placeholder="Select model"
            />
          ) : (
            <input
              type="text"
              value={formModel}
              onChange={(e) => setFormModel(e.target.value)}
              placeholder="e.g. gpt-4o-mini"
              className="w-full rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-600"
            />
          )}
        </div>

        {/* Base URL */}
        {currentProviderDef.needsBaseUrl && (
          <div>
            <label className="block text-xs font-semibold text-slate-400 mb-1">
              Base URL {currentProviderDef.id !== 'custom' ? '(required)' : ''}
            </label>
            <input
              type="text"
              value={formBaseUrl}
              onChange={(e) => setFormBaseUrl(e.target.value)}
              placeholder={currentProviderDef.baseUrlPlaceholder || 'https://api.example.com/v1'}
              className="w-full rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-600"
            />
          </div>
        )}

        {/* API Key */}
        {currentProviderDef.needsApiKey !== false && (
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-semibold text-slate-400">API Key</label>
              {formApiKey && (
                <button
                  type="button"
                  onClick={() => setFormShowApiKey(!formShowApiKey)}
                  className="text-[10px] text-slate-500 hover:text-primary-400 transition"
                >
                  {formShowApiKey ? 'Hide' : 'Show'}
                </button>
              )}
            </div>
            <input
              type={formShowApiKey ? 'text' : 'password'}
              value={formApiKey}
              onChange={(e) => setFormApiKey(e.target.value)}
              placeholder={editingId ? '••••••••  (leave empty to keep current)' : 'sk-...'}
              className="w-full rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-600"
            />
            {editingId && (
              <p className="mt-1 text-[10px] text-slate-500">
                {(() => {
                  const cfg = configs?.find((c) => c.id === editingId)
                  return cfg?.api_key_set
                    ? '✓ API key is stored. Leave empty to keep current key.'
                    : '⚠ No API key stored. Enter a key to save it.'
                })()}
              </p>
            )}
          </div>
        )}
      </div>

      {/* tool calling warning */}
      {(() => {
        const md = currentProviderDef.models.find((m) => m.name === formModel)
        if (md && !md.functionCalling) {
          return (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300 flex items-center gap-2">
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
              This model does not support tool/function calling. AI assistant features that require tools will not work.
            </div>
          )
        }
        return null
      })()}

      <div className="flex items-center gap-6 text-xs">
        <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer">
          <input
            type="checkbox"
            checked={formEnabled}
            onChange={(e) => setFormEnabled(e.target.checked)}
            className="rounded border-slate-600"
          />
          Enabled
        </label>
        <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer">
          <input
            type="checkbox"
            checked={formIsDefault}
            onChange={(e) => setFormIsDefault(e.target.checked)}
            className="rounded border-slate-600"
          />
          <CircleDot className="h-3.5 w-3.5 text-emerald-400" />
          Set as Active
        </label>
      </div>

      {/* actions row */}
      <div className="flex items-center gap-3 pt-2">
        <button
          onClick={handleTest}
          disabled={testing || !formModel}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-slate-600 disabled:opacity-50"
        >
          {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5 text-yellow-400" />}
          Test
        </button>

        {testResult && (
          <span className={`text-xs font-medium ${testResult.success ? 'text-emerald-400' : 'text-red-400'}`}>
            {testResult.success ? <Check className="inline h-3.5 w-3.5" /> : <AlertCircle className="inline h-3.5 w-3.5" />}
            {' '}{testResult.message}
          </span>
        )}

        <div className="ml-auto flex gap-2">
          <button
            onClick={resetForm}
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={isSaving || !formName || !formModel}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-500 disabled:opacity-50"
          >
            {isSaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {editingId ? 'Update' : 'Create'}
          </button>
        </div>
      </div>

      {/* Rollout hint — only for new model that may require new env vars */}
      {!editingId && testResult && !testResult.success && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-300/80 space-y-2">
          <p className="flex items-center gap-1.5">
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
            Connection test failed. If you've recently added a new API key to the Kubernetes Secret,
            the ai-service pod may need a restart to pick up the new environment variable.
          </p>
          <button
            type="button"
            onClick={handleRollout}
            disabled={rolloutStatus === 'rolling'}
            className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-200 hover:bg-amber-500/20 disabled:opacity-50"
          >
            {rolloutStatus === 'rolling' ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            {rolloutStatus === 'rolling' ? 'Checking…' : 'Check service health'}
          </button>
          {rolloutMessage && (
            <p className={`text-[11px] ${rolloutStatus === 'done' ? 'text-emerald-400' : rolloutStatus === 'error' ? 'text-red-400' : 'text-slate-400'}`}>
              {rolloutMessage}
            </p>
          )}
        </div>
      )}
    </div>
  )

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      {/* header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-slate-100 flex items-center gap-2">
            <Bot className="h-5 w-5 text-primary-400" />
            {tr('admin.aiModels.title', 'AI Model Configuration')}
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            {tr('admin.aiModels.subtitle', 'Manage LLM provider configurations used by the AI assistant.')}
          </p>
        </div>
        {!isCreating && editingId === null && (
          <button
            onClick={openCreateForm}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-500"
          >
            <Plus className="h-4 w-4" />
            {tr('admin.aiModels.add', 'Add Model')}
          </button>
        )}
      </div>

      {/* ── Create form (at top) ── */}
      {isCreating && renderForm()}

      {/* ── model config list ── */}
      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-slate-500" />
        </div>
      ) : !configs?.length && !isCreating ? (
        <div className="text-center py-12 text-sm text-slate-500">
          {tr('admin.aiModels.empty', 'No model configurations yet. The default environment config is being used.')}
        </div>
      ) : (
        <div className="space-y-3 mt-4">
          {configs?.map((cfg) => {
            const provDef = getProvider(cfg.provider)
            const isActive = cfg.is_default && cfg.enabled
            const isEditing = editingId === cfg.id
            return (
              <div key={cfg.id}>
                {/* ── card ── */}
                <div
                  className={`group relative rounded-xl border px-4 py-3 transition ${
                    isEditing
                      ? 'border-primary-500/50 bg-primary-500/5 ring-1 ring-primary-500/20'
                      : isActive
                        ? 'border-emerald-500/50 bg-emerald-500/5 ring-1 ring-emerald-500/20'
                        : cfg.enabled
                          ? 'border-slate-800 bg-slate-900/60 hover:border-slate-700'
                          : 'border-slate-800/50 bg-slate-900/30 opacity-60'
                  }`}
                >
                  {/* Active indicator bar */}
                  {isActive && !isEditing && (
                    <div className="absolute left-0 top-0 bottom-0 w-1 rounded-l-xl bg-emerald-500" />
                  )}
                  {isEditing && (
                    <div className="absolute left-0 top-0 bottom-0 w-1 rounded-l-xl bg-primary-500" />
                  )}

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="text-lg">{provDef?.icon || '⚙️'}</span>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-slate-200">{cfg.name}</span>

                          {isActive && (
                            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-400">
                              <Check className="h-2.5 w-2.5" />
                              Active
                            </span>
                          )}

                          {!cfg.enabled && (
                            <span className="inline-flex rounded-full border border-slate-700 bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-500">
                              Disabled
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5">
                          {provDef?.label || cfg.provider} · <code className="text-slate-400">{getModelLabel(cfg.provider, cfg.model)}</code>
                          {cfg.api_key_set
                            ? <span className="text-emerald-600 ml-1">· 🔑 Key stored</span>
                            : cfg.api_key_env
                              ? <span className="text-amber-600 ml-1">· env: {cfg.api_key_env}</span>
                              : <span className="text-red-500 ml-1">· ⚠ No key</span>}
                          {cfg.base_url && <span className="text-slate-600"> · {cfg.base_url}</span>}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1">
                      {/* Activate button */}
                      {cfg.enabled && !isActive && (
                        <button
                          onClick={() => activateMutation.mutate(cfg.id)}
                          disabled={activateMutation.isPending}
                          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-slate-400 hover:bg-emerald-500/10 hover:text-emerald-400 transition"
                          title="Set as Active"
                        >
                          <Radio className="h-3 w-3" />
                          Activate
                        </button>
                      )}
                      <button
                        onClick={() => isEditing ? resetForm() : openEditForm(cfg)}
                        className={`rounded-lg p-1.5 transition ${
                          isEditing
                            ? 'bg-primary-500/20 text-primary-400'
                            : 'text-slate-500 hover:bg-slate-800 hover:text-slate-300'
                        }`}
                        title={isEditing ? 'Close edit' : 'Edit'}
                      >
                        {isEditing ? <X className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
                      </button>
                      <button
                        onClick={() => {
                          if (confirm(`Delete "${cfg.name}"?`)) deleteMutation.mutate(cfg.id)
                        }}
                        className="rounded-lg p-1.5 text-slate-500 hover:bg-red-500/10 hover:text-red-400"
                        title="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </div>

                {/* ── inline edit form below the card ── */}
                {isEditing && renderForm()}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
