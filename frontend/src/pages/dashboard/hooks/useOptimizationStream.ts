// Optimization suggestions modal — open/close lifecycle, AI streaming
// state machine (typewriter queue, RAF/interval, abort controller),
// and the run / stop / copy handlers. Extracted from Dashboard.tsx
// because the streaming logic involves 8 state values + 8 refs +
// derived markdown — keeping it in the page made the page hard to
// reason about. The component now calls one hook and gets back a
// flat bundle of state + handlers to thread into OptimizationModal.

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '@/services/api'
import { useClusterFeatures } from '@/hooks/usePrometheusQuery'
import { aiEnabled } from '@/utils/features'

import { chatErrorText } from '@/utils/chatError'
import { unwrapOuterMarkdownFence } from '../utils'

interface UsageInfo {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

interface MetaInfo {
  finish_reason?: string | null
  max_tokens?: number | null
}

export function useOptimizationStream() {
  const { t } = useTranslation()
  const { data: features } = useClusterFeatures()
  const tr = (key: string, fallback: string, options?: Record<string, any>) =>
    t(key, { defaultValue: fallback, ...options })

  const [isOptimizationModalOpen, setIsOptimizationModalOpen] = useState(false)
  const [optimizationNamespace, setOptimizationNamespace] = useState<string>('default')
  const [isOptimizationNamespaceDropdownOpen, setIsOptimizationNamespaceDropdownOpen] = useState(false)
  const [optimizationCopied, setOptimizationCopied] = useState(false)
  const optimizationAbortRef = useRef<AbortController | null>(null)
  const [isOptimizationStreaming, setIsOptimizationStreaming] = useState(false)
  const [optimizationObservedContent, setOptimizationObservedContent] = useState('')
  const [optimizationAnswerContent, setOptimizationAnswerContent] = useState('')
  const [optimizationStreamError, setOptimizationStreamError] = useState('')
  const optimizationStreamPendingRef = useRef('')
  const optimizationStreamRafRef = useRef<number | null>(null)
  const optimizationStreamDoneRef = useRef(false)

  const optimizationCharQueueRef = useRef<string[]>([])
  const optimizationTypewriterRef = useRef<number | null>(null)
  const optimizationMetaReceivedRef = useRef(false)
  const optimizationUsageReceivedRef = useRef(false)
  const [optimizationUsage, setOptimizationUsage] = useState<UsageInfo | null>(null)
  const [optimizationMeta, setOptimizationMeta] = useState<MetaInfo | null>(null)

  // 모달 자체의 state reset + open. 부모는 다른 모달 닫고 이걸 호출.
  // initialNamespace 는 부모가 allNamespaces 보고 결정 (default 우선).
  const openOptimizationModal = (initialNamespace: string) => {
    setIsOptimizationNamespaceDropdownOpen(false)
    setOptimizationCopied(false)
    optimizationAbortRef.current?.abort()
    optimizationAbortRef.current = null
    if (optimizationStreamRafRef.current) {
      window.cancelAnimationFrame(optimizationStreamRafRef.current)
      optimizationStreamRafRef.current = null
    }
    optimizationStreamPendingRef.current = ''
    optimizationStreamDoneRef.current = false
    setIsOptimizationStreaming(false)
    setOptimizationObservedContent('')
    setOptimizationAnswerContent('')
    setOptimizationStreamError('')

    setOptimizationNamespace(initialNamespace)

    setIsOptimizationModalOpen(true)
  }

  const handleCloseOptimizationModal = () => {
    setIsOptimizationModalOpen(false)
    setIsOptimizationNamespaceDropdownOpen(false)
    setOptimizationCopied(false)
    optimizationAbortRef.current?.abort()
    optimizationAbortRef.current = null
    if (optimizationStreamRafRef.current) {
      window.cancelAnimationFrame(optimizationStreamRafRef.current)
      optimizationStreamRafRef.current = null
    }
    optimizationStreamPendingRef.current = ''
    optimizationStreamDoneRef.current = false
    setIsOptimizationStreaming(false)
    setOptimizationObservedContent('')
    setOptimizationAnswerContent('')
    setOptimizationStreamError('')
  }

  const stopOptimizationTypewriter = () => {
    if (optimizationTypewriterRef.current !== null) {
      clearInterval(optimizationTypewriterRef.current)
      optimizationTypewriterRef.current = null
    }
  }

  const drainOptimizationQueue = () => {
    const queue = optimizationCharQueueRef.current
    if (queue.length === 0) {
      stopOptimizationTypewriter()
      // 큐 소진 + 스트림 종료 → completed
      if (optimizationStreamDoneRef.current) {
        optimizationStreamDoneRef.current = false
        setOptimizationAnswerContent((prev) => unwrapOuterMarkdownFence(prev))
        setIsOptimizationStreaming(false)
      }
      return
    }
    // 적응형 배치: 큐 짧으면 1글자, 길면 많이 (따라잡기)
    const batch = Math.max(1, Math.ceil(queue.length / 8))
    const chars = queue.splice(0, batch).join('')
    setOptimizationAnswerContent((prev) => prev + chars)
  }

  const startOptimizationTypewriter = () => {
    if (optimizationTypewriterRef.current !== null) return
    optimizationTypewriterRef.current = window.setInterval(drainOptimizationQueue, 30)
  }

  const handleRunOptimizationSuggestions = () => {
    // Chart ai.enabled off: the table still shows the observed values; no suggestion stream (the gateway would answer 503).
    if (!optimizationNamespace || !aiEnabled(features)) return
    setOptimizationCopied(false)
    setIsOptimizationNamespaceDropdownOpen(false)
    optimizationAbortRef.current?.abort()
    const controller = new AbortController()
    optimizationAbortRef.current = controller

    setIsOptimizationStreaming(true)
    setOptimizationObservedContent('')
    setOptimizationAnswerContent('')
    setOptimizationStreamError('')
    setOptimizationUsage(null)
    setOptimizationMeta(null)
    optimizationMetaReceivedRef.current = false
    optimizationUsageReceivedRef.current = false
    optimizationStreamPendingRef.current = ''
    optimizationStreamDoneRef.current = false
    stopOptimizationTypewriter()
    optimizationCharQueueRef.current.length = 0

    void api
      .suggestOptimizationStream(optimizationNamespace, {
        signal: controller.signal,
        onObserved: (content) => {
          // Observed data 표는 한 번에 표시 (타자 효과 적용 X)
          setOptimizationObservedContent((prev) => prev + content)
        },
        onContent: (chunk) => {
          // 타자기 큐에 글자 추가
          for (const ch of chunk) {
            optimizationCharQueueRef.current.push(ch)
          }
          startOptimizationTypewriter()
        },
        onUsage: (usage) => {
          optimizationUsageReceivedRef.current = true
          setOptimizationUsage(usage)
        },
        onMeta: (meta) => {
          optimizationMetaReceivedRef.current = true
          setOptimizationMeta(meta)
        },
        onError: (message, key, args) => {
          setOptimizationStreamError(chatErrorText(t, message, key, args))
        },
        onDone: () => {
          if (!optimizationMetaReceivedRef.current) {
            setOptimizationStreamError((prev) => prev || tr(
              'dashboard.optimization.missingMeta',
              'Server did not send meta (finish reason). ai-service may not be rebuilt/restarted.',
            ))
          }
          optimizationStreamDoneRef.current = true
          // 큐가 비어있으면 즉시 완료, 아니면 타자기가 소진 후 자동 완료
          if (optimizationCharQueueRef.current.length === 0) {
            drainOptimizationQueue()
          }
          optimizationAbortRef.current = null
        },
      })
      .catch((error) => {
        if ((error as any)?.name === 'AbortError') return
        setOptimizationStreamError(error instanceof Error ? error.message : String(error))
        stopOptimizationTypewriter()
        optimizationCharQueueRef.current.length = 0
        optimizationStreamPendingRef.current = ''
        optimizationStreamDoneRef.current = false
        setIsOptimizationStreaming(false)
        optimizationAbortRef.current = null
      })
  }

  const handleCopyOptimizationSuggestions = async () => {
    const text = `${optimizationObservedContent}${unwrapOuterMarkdownFence(optimizationAnswerContent)}`.trim()
    if (!text) return

    try {
      await navigator.clipboard.writeText(text)
      setOptimizationCopied(true)
      setTimeout(() => setOptimizationCopied(false), 1500)
    } catch (error) {
      console.error('❌ 클립보드 복사 실패:', error)
      setOptimizationCopied(false)
    }
  }

  const handleStopOptimizationSuggestions = () => {
    optimizationAbortRef.current?.abort()
    optimizationAbortRef.current = null
    stopOptimizationTypewriter()
    // 큐에 남은 글자 즉시 반영
    if (optimizationCharQueueRef.current.length > 0) {
      const remaining = optimizationCharQueueRef.current.join('')
      optimizationCharQueueRef.current.length = 0
      setOptimizationAnswerContent((prev) => prev + remaining)
    }
    optimizationStreamPendingRef.current = ''
    optimizationStreamDoneRef.current = false
    setIsOptimizationStreaming(false)
  }

  // Component unmount 시 abort + interval 정리
  useEffect(() => {
    return () => {
      optimizationAbortRef.current?.abort()
      stopOptimizationTypewriter()
    }
  }, [])

  return {
    // state
    isOptimizationModalOpen,
    setIsOptimizationModalOpen,
    optimizationNamespace,
    setOptimizationNamespace,
    isOptimizationNamespaceDropdownOpen,
    setIsOptimizationNamespaceDropdownOpen,
    optimizationCopied,
    isOptimizationStreaming,
    optimizationObservedContent,
    optimizationAnswerContent,
    optimizationStreamError,
    optimizationUsage,
    optimizationMeta,
    // handlers
    openOptimizationModal,
    handleCloseOptimizationModal,
    handleRunOptimizationSuggestions,
    handleCopyOptimizationSuggestions,
    handleStopOptimizationSuggestions,
  }
}
