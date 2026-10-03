// AI Chat 의 도구 호출 결과를 ZIP 으로 다운로드. AIChat.tsx 의 handleDownloadJson
// 추출 (Phase 4.5.5.a).
//
// 부모는 message + sessionId + t (i18n) 만 전달. JSZip dynamic import (Monaco
// AMD loader 와 충돌 방지) + tool calls DB 보강 + sanitize / unique-name 가공
// 등 모든 zip 가공 로직을 자체 보유.

import { api } from '@/services/api'

const TRUNCATED_MARKER = '... (truncated) ...'

const hasTruncatedToolCalls = (toolCalls?: any[]) => {
  if (!Array.isArray(toolCalls)) return false
  return toolCalls.some((tc) => {
    if (!tc) return false
    const result = typeof tc.result === 'string' ? tc.result : ''
    const display = typeof tc.display === 'string' ? tc.display : ''
    return result.includes(TRUNCATED_MARKER) || display.includes(TRUNCATED_MARKER)
  })
}

interface Message {
  id?: number | null
  toolCalls?: Array<any> | null
  content?: string
  [key: string]: any
}

interface Args {
  message: Message
  sessionId: string | null
  t: (key: string, opts?: any) => string
  getCurrentMessages: () => Message[]
}

export async function exportToolCallsAsZip({ message, sessionId, t: _t, getCurrentMessages }: Args) {
  if (!message.toolCalls || message.toolCalls.length === 0) {
    return
  }

  try {
    const resolveToolCallsForDownload = async () => {
      const current = (message.toolCalls as any[]) || []
      // sessionId 는 부모에서 전달
      if (!sessionId) return current

      try {
        const session = await api.getSession(sessionId)
        let dbMessage: any | undefined
        const dbToolMessages = session.messages.filter(
          (m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
        )

        if (message.id != null) {
          dbMessage = session.messages.find((m) => m.id === message.id)
        }

        if (!dbMessage) {
          const candidates = dbToolMessages

          const currentFns = current
            .map((tc) => (tc && typeof tc.function === 'string' ? tc.function : ''))
            .filter((f) => f.length > 0)

          if (currentFns.length > 0) {
            // Prefer exact ordered match of tool names
            dbMessage = candidates.find((m) => {
              const fns = (m.tool_calls || []).map((tc: any) => String(tc?.function || '')).filter((f: string) => f)
              return fns.length === currentFns.length && fns.every((f: string, i: number) => f === currentFns[i])
            })
          }

          if (!dbMessage && currentFns.length > 0) {
            // Fallback to set match (unordered)
            const currentSet = new Set(currentFns)
            dbMessage = candidates.find((m) => {
              const fns = (m.tool_calls || []).map((tc: any) => String(tc?.function || '')).filter((f: string) => f)
              if (fns.length !== currentFns.length) return false
              const set = new Set(fns)
              if (set.size !== currentSet.size) return false
              for (const f of set) if (!currentSet.has(f)) return false
              return true
            })
          }

          if (!dbMessage && candidates.length > 0) {
            dbMessage = candidates[candidates.length - 1]
          }
        }

        if (!dbMessage && dbToolMessages.length > 0) {
          const uiToolMessages = getCurrentMessages().filter(
            (m) => m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0,
          )
          const uiIndex = uiToolMessages.findIndex((m) => m === message)
          if (uiIndex >= 0 && uiIndex < dbToolMessages.length) {
            dbMessage = dbToolMessages[uiIndex]
          }
        }

        if (!dbMessage && dbToolMessages.length > 0 && message.content) {
          const hint = message.content.trim().slice(0, 200)
          if (hint.length >= 20) {
            dbMessage = dbToolMessages.find(
              (m) => typeof m.content === 'string' && m.content.includes(hint)
            )
          }
        }

        if (!dbMessage && dbToolMessages.length > 0) {
          dbMessage = dbToolMessages[dbToolMessages.length - 1]
        }

        if (dbMessage?.tool_calls?.length) {
          return dbMessage.tool_calls
        }
      } catch (e) {
        console.warn('[WARN] Failed to load tool results from session:', e)
      }

      return current
    }

    let toolCalls = await resolveToolCallsForDownload()

    // If current toolCalls contain truncated markers, try to recover full results from DB
    if (hasTruncatedToolCalls(toolCalls)) {
      // sessionId 는 부모에서 전달
      if (sessionId) {
        try {
          const session = await api.getSession(sessionId)
          const candidates = session.messages
            .filter((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0)
            .reverse()

          const full = candidates.find((m) => !hasTruncatedToolCalls(m.tool_calls))
          if (full?.tool_calls?.length) {
            toolCalls = full.tool_calls
          }
        } catch (e) {
          console.warn('[WARN] Failed to recover full tool results from session:', e)
        }
      }
    }

    if (hasTruncatedToolCalls(toolCalls)) {
      console.warn('[WARN] Downloading truncated tool results (full results not available).')
    }
    const now = new Date()
    const pad = (n: number) => n.toString().padStart(2, '0')
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
      now.getDate()
    )}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`

    const sanitizeName = (value: string) =>
      value
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40) || 'tool'

    const nameCounts = new Map<string, number>()
    const getUniqueBase = (base: string) => {
      const current = nameCounts.get(base) || 0
      const next = current + 1
      nameCounts.set(base, next)
      return next > 1 ? `${base}_${next}` : base
    }

    const buildParamSuffix = (args: any) => {
      if (!args || typeof args !== 'object') return ''
      const parts: string[] = []
      const pushPart = (label: string, value: unknown) => {
        if (value == null) return
        const raw = Array.isArray(value) ? value.join(',') : String(value)
        const trimmed = raw.trim()
        if (!trimmed) return
        const limited = trimmed.length > 40 ? trimmed.slice(0, 40) : trimmed
        parts.push(`${label}-${limited}`)
      }
      pushPart('ns', args.namespace)
      pushPart('type', args.resource_type)
      pushPart('name', args.resource_name)
      pushPart('pod', args.pod_name)
      pushPart('svc', args.service_name)
      pushPart('name', args.name)
      pushPart('out', args.output)
      pushPart('ctr', args.container)
      if (parts.length === 0) return ''
      const joined = parts.slice(0, 4).join('_')
      const safe = sanitizeName(joined).slice(0, 60)
      return safe ? `_${safe}` : ''
    }

    const downloadZip = async (content: Blob, filename: string) => {
      const url = URL.createObjectURL(content)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    }

    const savedDefine = (window as any).define
    delete (window as any).define
    const { default: JSZip } = await import('jszip')
    if (savedDefine) (window as any).define = savedDefine
    const zip = new JSZip()

    for (const tc of toolCalls) {
      if (!tc) continue
      const functionName = typeof tc.function === 'string' ? tc.function : 'tool'
      const args = (tc.args || {}) as any
      const isJson = !!tc.is_json
      const isYaml = !!tc.is_yaml
      const isLog = functionName === 'get_pod_logs' || functionName === 'k8s_get_pod_logs'

      const content =
        typeof tc.result === 'string'
          ? String(tc.result)
          : JSON.stringify(tc.result ?? null, null, 2)

      const base = sanitizeName(functionName)
      const uniqueBase = getUniqueBase(base)
      const paramSuffix = buildParamSuffix(args)
      let ext = 'txt'
      if (isLog) {
        ext = 'log'
      } else if (isYaml) {
        ext = 'yaml'
      } else if (isJson) {
        ext = 'json'
      }

      const filename = `${uniqueBase}${paramSuffix}_${timestamp}.${ext}`
      zip.file(filename, content)
    }

    const zipBlob = await zip.generateAsync({ type: 'blob' })
    await downloadZip(zipBlob, `tool_results_${timestamp}.zip`)
  } catch (err) {
    console.error('[ERROR] Failed to download JSON:', err)
  }
}
