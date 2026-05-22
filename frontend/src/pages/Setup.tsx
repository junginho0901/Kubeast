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
import SetupApplyingOverlay from './setup/SetupApplyingOverlay'
import SetupClusterPage from './setup/SetupClusterPage'
import SetupAIModelPage from './setup/SetupAIModelPage'
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
        {page === 'cluster' && (
          <SetupClusterPage
            mode={mode}
            setMode={setMode}
            kubeconfigText={kubeconfigText}
            setKubeconfigText={setKubeconfigText}
            error={error}
            isApplying={isApplying}
            isBusy={isBusy}
            isLoadingStatus={isLoadingStatus}
            canSubmit={canSubmit}
            onSubmit={handleClusterSubmit}
            tr={tr}
          />
        )}

        {page === 'ai-model' && (
          <SetupAIModelPage navigatingRef={navigatingRef} tr={tr} />
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
