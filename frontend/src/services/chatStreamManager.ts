import { getAuthHeaders, handleUnauthorized } from '@/services/auth'

export type StreamingPhase = 'waiting' | 'tools' | 'answer'

export type ChatStreamStatus = 'idle' | 'streaming' | 'completed' | 'aborted' | 'error'

export interface ChatStreamState {
  status: ChatStreamStatus
  isStreaming: boolean
  sessionId: string | null
  userMessage: string | null
  assistantContent: string
  functionCallsContent: string
  toolCalls: any[]
  streamingPhase: StreamingPhase | null
  error: string | null
  updatedAt: number
}

type Listener = (state: ChatStreamState) => void

const initialState: ChatStreamState = {
  status: 'idle',
  isStreaming: false,
  sessionId: null,
  userMessage: null,
  assistantContent: '',
  functionCallsContent: '',
  toolCalls: [],
  streamingPhase: null,
  error: null,
  updatedAt: Date.now(),
}

function safeJsonStringify(value: unknown) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function buildToolCallBlock(functionName: string, args: any) {
  const argsSection =
    args && typeof args === 'object' && Object.keys(args).length > 0
      ? `<details>
<summary><strong>📋 Arguments</strong></summary>

\`\`\`json
${safeJsonStringify(args)}
\`\`\`

</details>`
      : '<p><strong>📋 Arguments:</strong> No arguments</p>'

  return `<details>
<summary>🔧 <strong>${functionName}</strong></summary>

${argsSection}

<details>
<summary><strong>📊 Results</strong></summary>

Executing...

</details>

</details>

`
}

class ChatStreamManager {
  private state: ChatStreamState = initialState
  private listeners = new Set<Listener>()
  private abortController: AbortController | null = null

  // 타자기 효과: 도착한 텍스트를 큐에 넣고 RAF로 적응형 배치 드레인
  private _charQueue: string[] = []
  private _typewriterTimer: number | null = null
  private _streamDone = false          // SSE [DONE] 수신 여부
  private _pendingDonePatch: Partial<ChatStreamState> | null = null
  private static readonly TICK_MS = 30 // 드레인 간격 (ms)

  getState = () => this.state

  subscribe = (listener: Listener) => {
    this.listeners.add(listener)
    listener(this.state)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify = () => {
    for (const listener of this.listeners) listener(this.state)
  }

  /** 적응형 드레인: 큐가 쌓이면 한번에 더 많이 꺼냄 (밀림 방지) */
  private _drainQueue = () => {
    if (this._charQueue.length === 0) {
      this._stopTypewriter()
      // 스트림 종료 후 큐 소진 완료 → completed 상태 전환
      if (this._streamDone && this._pendingDonePatch) {
        const patch = this._pendingDonePatch
        this._pendingDonePatch = null
        this._streamDone = false
        this.state = { ...this.state, ...patch, updatedAt: Date.now() }
        this.notify()
      }
      return
    }
    // 적응형 배치: 큐 길이에 비례해서 한번에 꺼냄
    // 짧으면 1글자씩 (부드러움), 길면 많이 (따라잡기)
    const batch = Math.max(1, Math.ceil(this._charQueue.length / 8))
    const chars = this._charQueue.splice(0, batch).join('')
    this.state = {
      ...this.state,
      assistantContent: this.state.assistantContent + chars,
      streamingPhase: 'answer',
      updatedAt: Date.now(),
    }
    this.notify()
  }

  /** 큐에 남은 글자 전부 즉시 반영 (abort 시에만 사용) */
  private _flushQueue = () => {
    if (this._charQueue.length === 0) return
    const remaining = this._charQueue.join('')
    this._charQueue.length = 0
    this.state = {
      ...this.state,
      assistantContent: this.state.assistantContent + remaining,
      updatedAt: Date.now(),
    }
    this._stopTypewriter()
    this.notify()
  }

  private _startTypewriter = () => {
    if (this._typewriterTimer !== null) return
    this._typewriterTimer = window.setInterval(this._drainQueue, ChatStreamManager.TICK_MS)
  }

  private _stopTypewriter = () => {
    if (this._typewriterTimer !== null) {
      clearInterval(this._typewriterTimer)
      this._typewriterTimer = null
    }
  }

  /** 스트림 종료를 지연 — 큐가 다 소진된 후에 상태 전환 */
  private _finishWhenDrained = (patch: Partial<ChatStreamState>) => {
    this._streamDone = true
    this._pendingDonePatch = patch
    // 큐가 이미 비어있으면 즉시 완료
    if (this._charQueue.length === 0) {
      this._drainQueue()
    }
    // 큐가 남아있으면 타자기가 소진 후 자동 완료
  }

  private setState = (patch: Partial<ChatStreamState>, immediate = false) => {
    this.state = { ...this.state, ...patch, updatedAt: Date.now() }

    if (immediate) {
      this._flushQueue()
      this._streamDone = false
      this._pendingDonePatch = null
      this.notify()
      return
    }

    this.notify()
  }

  stop = async () => {
    if (this.abortController) {
      try {
        this.abortController.abort()
      } finally {
        this.abortController = null
      }
    }

    if (this.state.status === 'streaming') {
      this.setState({ status: 'aborted', isStreaming: false }, true)
    }
  }

  startSessionChat = async (sessionId: string, userMessage: string) => {
    if (this.state.isStreaming) {
      throw new Error('이미 답변 생성 중입니다. 먼저 중단해 주세요.')
    }

    this.abortController = new AbortController()
    this._stopTypewriter()
    this._charQueue.length = 0
    this._streamDone = false
    this._pendingDonePatch = null
    this.setState({
      status: 'streaming',
      isStreaming: true,
      sessionId,
      userMessage,
      assistantContent: '',
      functionCallsContent: '',
      toolCalls: [],
      streamingPhase: 'waiting',
      error: null,
    })

    try {
      const response = await fetch(
        `/api/v1/ai/sessions/${sessionId}/chat?message=${encodeURIComponent(userMessage)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
          signal: this.abortController.signal,
        }
      )

      if (response.status === 401) {
        handleUnauthorized()
        throw new Error('Unauthorized')
      }

      if (!response.body) throw new Error('No response body')

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, { stream: true })
        buffer += chunk

        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const rawLine of lines) {
          const line = rawLine.trim()
          if (!line) continue
          if (!line.startsWith('data: ')) continue

          const dataStr = line.slice(6)
          if (dataStr === '[DONE]') {
            this._finishWhenDrained({ status: 'completed', isStreaming: false, streamingPhase: null })
            return
          }

          try {
            const data = JSON.parse(dataStr)

            if (data.model_info) {
              console.info(
                '%c[AI Model] %c%s %c/ %s %c(role: %s)',
                'color:#10b981;font-weight:bold',
                'color:#60a5fa;font-weight:bold', String(data.model_info.provider || ''),
                'color:#94a3b8', String(data.model_info.model || ''),
                'color:#94a3b8', String(data.model_info.role || ''),
              )
              continue
            }

            if (data.usage) {
              const phase = data.usage_phase ? ` (${String(data.usage_phase)})` : ''
              // console.debug 는 브라우저 설정에 따라 숨겨질 수 있어 info 로 출력
              console.info('[TOKENS]' + phase, data.usage)
              continue
            }

            if (data.content) {
              // 타자기 큐에 글자 추가 → setInterval이 한 글자씩 꺼내서 렌더
              const chars = String(data.content)
              for (const ch of chars) {
                this._charQueue.push(ch)
              }
              this._startTypewriter()
              continue
            }

            if (data.function) {
              const toolCall = {
                function: data.function,
                args: data.args || {},
                result: '',
                is_json: false,
                is_yaml: false,
              }

              this.setState({
                toolCalls: [...this.state.toolCalls, toolCall],
                functionCallsContent: this.state.functionCallsContent + buildToolCallBlock(data.function, data.args || {}),
                streamingPhase: 'tools',
              })
              continue
            }

            if (data.function_result) {
              const functionName = String(data.function_result)
              const isJson = !!data.is_json
              const isYaml = !!data.is_yaml
              const resultText = String(data.result ?? '')
              const displayText = data.display ? String(data.display) : ''
              const displayFormat = data.display_format ? String(data.display_format) : ''

              const toolCalls = this.state.toolCalls.map((tc) =>
                tc.function === functionName
                  ? { ...tc, result: resultText, is_json: isJson, is_yaml: isYaml }
                  : tc
              )
              const mergedToolCalls = toolCalls.map((tc) =>
                tc.function === functionName && displayText
                  ? { ...tc, display: displayText, display_format: displayFormat }
                  : tc
              )

              const lastFunctionIndex = this.state.functionCallsContent.lastIndexOf(
                `<summary>🔧 <strong>${functionName}</strong></summary>`
              )

              let functionCallsContent = this.state.functionCallsContent
              if (lastFunctionIndex !== -1) {
                const beforeFunction = functionCallsContent.substring(0, lastFunctionIndex)
                const afterFunction = functionCallsContent.substring(lastFunctionIndex)

                const bodyText = displayText || resultText
                const codeBlock = displayText
                  ? `\`\`\`\n${bodyText}\n\`\`\``
                  : isYaml
                  ? `\`\`\`yaml\n${bodyText}\n\`\`\``
                  : isJson
                  ? `\`\`\`json\n${bodyText}\n\`\`\``
                  : `\`\`\`\n${bodyText}\n\`\`\``
                functionCallsContent = beforeFunction + afterFunction.replace('Executing...', codeBlock)
              }

              this.setState({
                toolCalls: mergedToolCalls,
                functionCallsContent,
                streamingPhase: 'tools',
              })
              continue
            }

            if (data.error) {
              this.setState({
                status: 'error',
                isStreaming: false,
                error: String(data.error),
                streamingPhase: null,
              }, true)
              return
            }
          } catch {
            // ignore invalid JSON chunks
          }
        }
      }

      this._finishWhenDrained({ status: 'completed', isStreaming: false, streamingPhase: null })
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        this.setState({ status: 'aborted', isStreaming: false, streamingPhase: null }, true)
        return
      }

      this.setState({
        status: 'error',
        isStreaming: false,
        error: String(error),
        streamingPhase: null,
      }, true)
    } finally {
      this.abortController = null
    }
  }
}

export const chatStreamManager = new ChatStreamManager()
