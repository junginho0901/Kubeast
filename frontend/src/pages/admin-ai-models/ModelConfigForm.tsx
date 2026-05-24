import { useTranslation } from 'react-i18next'
import CustomDropdown from '@/components/CustomDropdown'
import {
  Check,
  AlertCircle,
  Loader2,
  Plus,
  Pencil,
  Zap,
  X,
  CircleDot,
  RefreshCw,
} from 'lucide-react'
import { providerOptions } from './helpers'
import type { ModelFormState } from './useModelForm'

interface Props {
  form: ModelFormState
}

export default function ModelConfigForm({ form }: Props) {
  const { t } = useTranslation()
  const tr = (key: string, fb: string) => t(key, { defaultValue: fb })
  const {
    configs,
    editingId,
    formName, setFormName,
    formProvider,
    formModel, setFormModel,
    formCustomModel, setFormCustomModel,
    formBaseUrl, setFormBaseUrl,
    formApiKey, setFormApiKey,
    formShowApiKey, setFormShowApiKey,
    formEnabled, setFormEnabled,
    formIsDefault, setFormIsDefault,
    testing,
    testResult,
    rolloutStatus,
    rolloutMessage,
    currentProviderDef,
    currentModelOptions,
    isSaving,
    resetForm,
    handleProviderChange,
    handleSubmit,
    handleTest,
    handleRollout,
  } = form

  return (
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
}
