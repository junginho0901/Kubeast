import { Check, ChevronRight, Loader2 } from 'lucide-react'
import { STEPS, type StepPhase } from './types'

interface SetupApplyingOverlayProps {
  currentStep: StepPhase | null
  completedSteps: Set<StepPhase>
  tr: (key: string, fallback: string) => string
}

export default function SetupApplyingOverlay({
  currentStep,
  completedSteps,
  tr,
}: SetupApplyingOverlayProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm">
      <div className="w-[min(92vw,540px)] rounded-2xl border border-slate-800 bg-slate-900/90 px-8 py-7 shadow-2xl">
        <div className="mb-6 text-center">
          <h2 className="text-base font-semibold text-slate-100">
            {tr('setup.applying.title', 'Applying cluster setup')}
          </h2>
        </div>

        <div className="flex items-center justify-center gap-1">
          {STEPS.map((step, idx) => {
            const isDone = completedSteps.has(step.phase)
            const isActive = currentStep === step.phase
            const isPending = !isDone && !isActive

            return (
              <div key={step.phase} className="flex items-center gap-1">
                <div
                  className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-all duration-500 ${
                    isDone
                      ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                      : isActive
                        ? 'border-primary-500/60 bg-primary-500/20 text-primary-200 shadow-[0_0_12px_rgba(59,130,246,0.25)]'
                        : 'border-slate-700/50 bg-slate-800/30 text-slate-500'
                  }`}
                >
                  {isDone ? (
                    <Check className="h-3.5 w-3.5 text-emerald-400" />
                  ) : isActive ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-primary-400" />
                  ) : (
                    <div className="h-2 w-2 rounded-full bg-slate-600" />
                  )}
                  <span className={isPending ? 'opacity-50' : ''}>
                    {tr(step.labelKey, step.fallback)}
                  </span>
                </div>

                {idx < STEPS.length - 1 && (
                  <ChevronRight
                    className={`h-3.5 w-3.5 flex-shrink-0 transition-colors duration-500 ${
                      isDone ? 'text-emerald-500/60' : 'text-slate-700'
                    }`}
                  />
                )}
              </div>
            )
          })}
        </div>

        <p className="mt-5 text-center text-xs text-slate-500">
          {tr('setup.applying.desc', 'This may take up to 2 minutes.')}
        </p>
      </div>
    </div>
  )
}
