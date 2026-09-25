// AI API — log analysis / chat / optimization (sync + SSE stream).
// suggestOptimizationStream uses raw fetch instead of axios so it can
// consume the response body as a stream of SSE events.

import { getAccessToken, handleUnauthorized } from '../auth'

import { client } from './client'
import type {
  ChatResponse,
  LogAnalysisResponse,
  OptimizationStreamHandlers,
  OptimizationSuggestionsResponse,
} from './types'

export interface ToolApproval {
  id: string
  session_id: string
  cluster: string
  tool: string
  args: Record<string, unknown>
  status: 'pending' | 'approved' | 'executed' | 'failed' | 'rejected' | 'expired'
  result: string | null
  created_at: string | null
  expires_at: string | null
  decided_at: string | null
}

export const aiApi = {
  // AI write-tool approvals (H2): the model's write call waits here until the user decides.
  listToolApprovals: async (sessionId: string): Promise<ToolApproval[]> => {
    const { data } = await client.get('/ai/tool-approvals', { params: { session_id: sessionId } })
    return data
  },
  getToolApproval: async (id: string): Promise<ToolApproval> => {
    const { data } = await client.get(`/ai/tool-approvals/${id}`)
    return data
  },
  approveToolCall: async (id: string): Promise<ToolApproval> => {
    const { data } = await client.post(`/ai/tool-approvals/${id}/approve`, null, { timeout: 90000 })
    return data
  },
  rejectToolCall: async (id: string): Promise<ToolApproval> => {
    const { data } = await client.post(`/ai/tool-approvals/${id}/reject`)
    return data
  },

  analyzeLogs: async (request: {
    logs: string
    namespace: string
    pod_name: string
    container?: string
  }): Promise<LogAnalysisResponse> => {
    const { data } = await client.post('/ai/analyze-logs', request)
    return data
  },

  chat: async (messages: Array<{ role: string; content: string }>): Promise<ChatResponse> => {
    const { data } = await client.post('/ai/chat', { messages })
    return data
  },

  suggestOptimization: async (namespace: string): Promise<OptimizationSuggestionsResponse> => {
    const { data } = await client.post(
      '/ai/suggest-optimization',
      null,
      {
        params: { namespace },
        timeout: 60000,
      },
    )
    return data
  },

  suggestOptimizationStream: async (namespace: string, handlers: OptimizationStreamHandlers = {}): Promise<void> => {
    const { onObserved, onContent, onUsage, onMeta, onError, onDone, signal } = handlers

    const headers: Record<string, string> = { Accept: 'text/event-stream' }
    const token = getAccessToken()
    if (token) headers.Authorization = `Bearer ${token}`

    const response = await fetch(`/api/v1/ai/suggest-optimization/stream?namespace=${encodeURIComponent(namespace)}`, {
      method: 'GET',
      headers,
      signal,
    })

    if (response.status === 401) {
      const message = 'Unauthorized'
      onError?.(message)
      handleUnauthorized()
      throw new Error(message)
    }

    if (!response.ok) {
      const message = `HTTP ${response.status}`
      onError?.(message)
      throw new Error(message)
    }

    if (!response.body) {
      const message = 'No response body'
      onError?.(message)
      throw new Error(message)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    let aborted = false
    let sawDone = false

    const processEventBlock = (block: string) => {
      const lines = block.split('\n')
      let didEmit = false
      for (const rawLine of lines) {
        const line = rawLine.trimEnd()
        if (!line.startsWith('data:')) continue
        const payload = line.slice('data:'.length).trim()
        if (!payload) continue
        if (payload === '[DONE]') {
          sawDone = true
          onDone?.()
          return { status: 'done' as const, didEmit }
        }
        try {
          const parsed = JSON.parse(payload) as any
          const kind = typeof parsed?.kind === 'string' ? parsed.kind : undefined
          if (kind === 'usage' && parsed?.usage) {
            onUsage?.(parsed.usage)
            didEmit = true
            continue
          }
          if (kind === 'meta') {
            onMeta?.({ finish_reason: parsed?.finish_reason, max_tokens: parsed?.max_tokens })
            didEmit = true
            continue
          }
          if (parsed?.error != null) {
            onError?.(String(parsed.error))
          }
          if (typeof parsed?.content === 'string') {
            const contentKind = kind ?? 'answer'
            if (contentKind === 'observed') {
              onObserved?.(parsed.content)
            } else {
              onContent?.(parsed.content)
            }
            didEmit = true
          }
        } catch {
          // ignore non-json payload
        }
      }
      return { status: 'continue' as const, didEmit }
    }

    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        for (;;) {
          const sepIndex = buffer.indexOf('\n\n')
          if (sepIndex === -1) break
          const eventBlock = buffer.slice(0, sepIndex)
          buffer = buffer.slice(sepIndex + 2)
          const result = processEventBlock(eventBlock)
          if (result.status === 'done') return
          if (result.didEmit) await new Promise((resolve) => setTimeout(resolve, 0))
        }
      }
    } catch (error) {
      if ((error as any)?.name !== 'AbortError') {
        onError?.(error instanceof Error ? error.message : String(error))
        throw error
      }
      aborted = true
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // ignore
      }
    }

    if (aborted) return
    if (!sawDone) {
      const message = 'Stream ended unexpectedly (missing [DONE])'
      onError?.(message)
      throw new Error(message)
    }
  },
}
