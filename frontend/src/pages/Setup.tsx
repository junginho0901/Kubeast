import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { api } from '@/services/api'
import { useTranslation } from 'react-i18next'
import {
  Check,
  CheckCircle2,
  ChevronRight,
  Database,
  Loader2,
  UploadCloud,
  Bot,
  Zap,
  AlertCircle,
} from 'lucide-react'
import {
  PROVIDER_CATALOG,
  getProvider,
  type ProviderDef,
} from '@/constants/modelCatalog'
import CustomDropdown, { type DropdownOption } from '@/components/CustomDropdown'
import SetupApplyingOverlay from './setup/SetupApplyingOverlay'
import { type SetupMode, type WizardPage, type StepPhase } from './setup/types'

/* ═══════════════════════════════════════
   Component
   ═══════════════════════════════════════ */
export default function Setup() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, opts?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...opts })

  /* ── wizard state ── */
  const [page, setPage] = useState<WizardPage>('cluster')

  /* ── cluster step state ── */
  const [mode, setMode] = useState<SetupMode>('in_cluster')
  const [kubeconfigText, setKubeconfigText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isApplying, setIsApplying] = useState(false)
  const [currentStep, setCurrentStep] = useState<StepPhase | null>(null)
  const [completedSteps, setCompletedSteps] = useState<Set<StepPhase>>(new Set())
  const navigatingRef = useRef(false)

  /* ── AI model state ── */
  const [selectedProvider, setSelectedProvider] = useState('openai')
  const [aiModel, setAiModel] = useState('gpt-4o-mini')
  const [aiCustomModel, setAiCustomModel] = useState(false) // true = free text input
  const [aiApiKey, setAiApiKey] = useState('')
  const [aiBaseUrl, setAiBaseUrl] = useState('')
  const [aiTesting, setAiTesting] = useState(false)
  const [aiTestResult, setAiTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [aiSaving, setAiSaving] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)

  const markComplete = (phase: StepPhase) =>
    setCompletedSteps((prev) => new Set(prev).add(phase))

  const { data: status, isLoading: isLoadingStatus } = useQuery({
    queryKey: ['setup-status'],
    queryFn: api.getSetupStatus,
  })

  /* If already configured, jump to AI model page */
  useEffect(() => {
    if (navigatingRef.current) return
    if (status?.configured && !isApplying && page === 'cluster') {
      setPage('ai-model')
    }
  }, [status, isApplying, page])

  /* ── provider change handler ── */
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

  /* dropdown options derived from catalog */
  const modelDropdownOptions: DropdownOption[] = useMemo(
    () =>
      currentProviderDef.models.map((m) => ({
        value: m.name,
        label: m.label ?? m.name,
        hint: !m.functionCalling ? 'no tools' : undefined,
      })),
    [currentProviderDef],
  )

  /* ═══════════════════════════════════════
     Cluster setup mutation
     ═══════════════════════════════════════ */
  const submitMutation = useMutation({
    mutationFn: async () => {
      setCurrentStep('validate')
      setIsApplying(true)
      await new Promise((r) => setTimeout(r, 400))
      markComplete('validate')
      setCurrentStep('save')

      const result = await api.submitSetup({
        mode,
        kubeconfig: mode === 'external' ? kubeconfigText.trim() : undefined,
      })
      return result
    },
    onSuccess: () => {
      markComplete('save')
      setCurrentStep('rollout')
    },
    onError: (err: any) => {
      setError(
        err?.response?.data?.detail || tr('setup.errors.failed', 'Failed to apply setup.')
      )
      setIsApplying(false)
      setCurrentStep(null)
      setCompletedSteps(new Set())
    },
  })

  const isBusy = submitMutation.isPending || isApplying

  const handleFileUpload = (file?: File | null) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setKubeconfigText(String(reader.result || ''))
    reader.readAsText(file)
  }

  const canSubmit = useMemo(() => {
    if (mode === 'external') return Boolean(kubeconfigText.trim())
    return true
  }, [mode, kubeconfigText])

  const handleClusterSubmit = () => {
    if (!canSubmit || isBusy) return
    setError(null)
    setCompletedSteps(new Set())
    submitMutation.mutate()
  }

  /* ── polling after cluster submit ── */
  const pollingRef = useRef(false)

  useEffect(() => {
    // Start polling when rollout begins and keep polling through connect
    if (!isApplying) return
    if (currentStep !== 'rollout' && currentStep !== 'connect') return
    if (navigatingRef.current) return
    if (pollingRef.current) return  // prevent duplicate polling
    pollingRef.current = true

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const startedAt = Date.now()
    const timeoutMs = 120_000
    const intervalMs = 3000
    let rolloutDone = currentStep === 'connect'

    const poll = async () => {
      if (cancelled || navigatingRef.current) return

      // Phase 1: Wait for rollout to complete
      if (!rolloutDone) {
        try {
          const rollout = await api.getRolloutStatus()
          if (rollout?.ready) {
            rolloutDone = true
            markComplete('rollout')
            setCurrentStep('connect')
          }
        } catch {
          /* auth-service might be restarting too — keep polling */
        }
      }

      // Phase 2: Once rollout is done, check health
      if (rolloutDone) {
        try {
          const health = await api.getHealth()
          const kubeStatus = String(health?.kubernetes || '')
          if (health?.status === 'healthy' && kubeStatus === 'connected') {
            if (!cancelled && !navigatingRef.current) {
              markComplete('connect')
              cancelled = true
              setTimeout(() => {
                setIsApplying(false)
                setCurrentStep(null)
                pollingRef.current = false
                setPage('ai-model')
              }, 600)
            }
            return
          }
        } catch {
          /* k8s-service still connecting to cluster — keep polling */
        }
      }

      if (Date.now() - startedAt >= timeoutMs) {
        if (!cancelled) {
          setIsApplying(false)
          setCurrentStep(null)
          pollingRef.current = false
          setError(
            tr(
              'setup.errors.timeout',
              'Cluster connection timed out. Please check the kubeconfig and try again.'
            )
          )
        }
        return
      }

      if (!cancelled) {
        timer = setTimeout(poll, intervalMs)
      }
    }

    poll()
    return () => {
      cancelled = true
      pollingRef.current = false
      if (timer) clearTimeout(timer)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isApplying, currentStep])

  /* ═══════════════════════════════════════
     AI model handlers
     ═══════════════════════════════════════ */
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

  /* ═══════════════════════════════════════
     RENDER
     ═══════════════════════════════════════ */
  return (
    <div className="min-h-screen bg-slate-950 text-white">
      {/* background gradients */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(37,99,235,0.18),rgba(2,6,23,0))]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom,rgba(34,211,238,0.12),rgba(2,6,23,0))]" />
      </div>

      {/* ───── wizard indicator ───── */}
      <div className="relative z-10 flex items-center justify-center gap-3 pt-8">
        <div
          className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium ${
            page === 'cluster'
              ? 'border-primary-500/60 bg-primary-500/20 text-primary-200'
              : 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
          }`}
        >
          {page !== 'cluster' ? (
            <Check className="h-3.5 w-3.5 text-emerald-400" />
          ) : (
            <Database className="h-3.5 w-3.5" />
          )}
          {tr('setup.wizard.cluster', 'Cluster')}
        </div>
        <ChevronRight className="h-3.5 w-3.5 text-slate-600" />
        <div
          className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium ${
            page === 'ai-model'
              ? 'border-primary-500/60 bg-primary-500/20 text-primary-200'
              : 'border-slate-700/50 bg-slate-800/30 text-slate-500'
          }`}
        >
          <Bot className="h-3.5 w-3.5" />
          {tr('setup.wizard.ai', 'AI Model')}
        </div>
      </div>

      <div className="relative mx-auto flex min-h-[calc(100vh-80px)] w-[min(92vw,1200px)] items-center px-6 py-8">
        {/* ════════════════════════════════════
            PAGE 1: Cluster Setup
           ════════════════════════════════════ */}
        {page === 'cluster' && (
          <div
            className={`mx-auto w-full max-w-3xl space-y-8 transition-opacity duration-300 ${
              isApplying ? 'pointer-events-none opacity-40' : ''
            }`}
          >
            {/* header */}
            <div className="space-y-2">
              <div className="inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900/40 px-3 py-1 text-xs text-slate-300">
                <div className="h-2 w-2 rounded-full bg-primary-500" />
                {tr('setup.badge', 'Initial cluster setup')}
              </div>
              <h1 className="text-3xl font-semibold">
                {tr('setup.title', 'Connect a Kubernetes cluster')}
              </h1>
              <p className="text-sm text-slate-400">
                {tr('setup.subtitle', 'Choose the cluster to manage before signing in.')}
              </p>
            </div>

            {/* mode selector */}
            <div className="grid gap-4 md:grid-cols-2">
              <button
                type="button"
                onClick={() => setMode('in_cluster')}
                className={`rounded-2xl border px-4 py-5 text-left transition ${
                  mode === 'in_cluster'
                    ? 'border-primary-500/60 bg-primary-500/10'
                    : 'border-slate-800 bg-slate-900/40 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <CheckCircle2 className="h-4 w-4 text-primary-400" />
                  {tr('setup.option.incluster.title', 'Use this cluster')}
                </div>
                <p className="mt-2 text-xs text-slate-400">
                  {tr('setup.option.incluster.desc', 'Manage the cluster where this solution is installed.')}
                </p>
              </button>

              <button
                type="button"
                onClick={() => setMode('external')}
                className={`rounded-2xl border px-4 py-5 text-left transition ${
                  mode === 'external'
                    ? 'border-primary-500/60 bg-primary-500/10'
                    : 'border-slate-800 bg-slate-900/40 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <Database className="h-4 w-4 text-cyan-400" />
                  {tr('setup.option.external.title', 'Connect external cluster')}
                </div>
                <p className="mt-2 text-xs text-slate-400">
                  {tr('setup.option.external.desc', 'Provide a kubeconfig to connect another cluster.')}
                </p>
              </button>
            </div>

            {/* kubeconfig input */}
            {mode === 'external' && (
              <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm font-semibold">
                    {tr('setup.external.title', 'Kubeconfig')}
                  </div>
                  <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-1 text-xs text-slate-200">
                    <UploadCloud className="h-4 w-4 text-slate-300" />
                    {tr('setup.external.upload', 'Upload file')}
                    <input
                      type="file"
                      accept=".yaml,.yml,.conf,.txt"
                      className="hidden"
                      onChange={(e) => handleFileUpload(e.target.files?.[0])}
                    />
                  </label>
                </div>
                <textarea
                  className="mt-3 h-48 w-full rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-primary-600"
                  placeholder={tr('setup.external.placeholder', 'Paste kubeconfig content here...')}
                  value={kubeconfigText}
                  onChange={(e) => setKubeconfigText(e.target.value)}
                />
              </div>
            )}

            {/* error */}
            {error && (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                {error}
              </div>
            )}

            {/* submit */}
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleClusterSubmit}
                disabled={!canSubmit || isBusy || isLoadingStatus}
                className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isBusy
                  ? tr('setup.submit.loading', 'Applying...')
                  : tr('setup.submit', 'Continue')}
              </button>
            </div>
          </div>
        )}

        {/* ════════════════════════════════════
            PAGE 2: AI Model Config
           ════════════════════════════════════ */}
        {page === 'ai-model' && (
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
        )}
      </div>

      {isApplying && page === 'cluster' && (
        <SetupApplyingOverlay
          currentStep={currentStep}
          completedSteps={completedSteps}
          tr={tr}
        />
      )}
    </div>
  )
}
