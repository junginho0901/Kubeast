import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/services/api'
import { useTranslation } from 'react-i18next'
import { Bot, Check, ChevronRight, Database } from 'lucide-react'
import SetupClusterPage from './setup/SetupClusterPage'
import SetupAIModelPage from './setup/SetupAIModelPage'
import SetupApplyingOverlay from './setup/SetupApplyingOverlay'
import { useClusterSubmit } from './setup/useClusterSubmit'
import type { SetupMode, WizardPage } from './setup/types'

export default function Setup() {
  const { t } = useTranslation()
  const tr = (key: string, fallback: string, opts?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...opts })

  const [page, setPage] = useState<WizardPage>('cluster')
  const [mode, setMode] = useState<SetupMode>('in_cluster')
  const [kubeconfigText, setKubeconfigText] = useState('')
  const navigatingRef = useRef(false)

  const { data: status, isLoading: isLoadingStatus } = useQuery({
    queryKey: ['setup-status'],
    queryFn: api.getSetupStatus,
  })

  const {
    error,
    isApplying,
    currentStep,
    completedSteps,
    isBusy,
    canSubmit,
    handleClusterSubmit,
  } = useClusterSubmit({
    mode,
    kubeconfigText,
    navigatingRef,
    onConnected: () => setPage('ai-model'),
    tr,
  })

  /* If already configured, jump to AI model page */
  useEffect(() => {
    if (navigatingRef.current) return
    if (status?.configured && !isApplying && page === 'cluster') {
      setPage('ai-model')
    }
  }, [status, isApplying, page])

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
