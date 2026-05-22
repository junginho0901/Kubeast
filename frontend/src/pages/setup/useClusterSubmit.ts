import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '@/services/api'
import type { SetupMode, StepPhase } from './types'

interface UseClusterSubmitOpts {
  mode: SetupMode
  kubeconfigText: string
  navigatingRef: MutableRefObject<boolean>
  onConnected: () => void
  tr: (key: string, fallback: string) => string
}

export function useClusterSubmit({
  mode,
  kubeconfigText,
  navigatingRef,
  onConnected,
  tr,
}: UseClusterSubmitOpts) {
  const [error, setError] = useState<string | null>(null)
  const [isApplying, setIsApplying] = useState(false)
  const [currentStep, setCurrentStep] = useState<StepPhase | null>(null)
  const [completedSteps, setCompletedSteps] = useState<Set<StepPhase>>(new Set())
  const pollingRef = useRef(false)

  const markComplete = (phase: StepPhase) =>
    setCompletedSteps((prev) => new Set(prev).add(phase))

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
                onConnected()
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

  return {
    error,
    isApplying,
    currentStep,
    completedSteps,
    isBusy,
    canSubmit,
    handleClusterSubmit,
  }
}
