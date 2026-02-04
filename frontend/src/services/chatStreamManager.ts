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

  getState = () => this.state

  subscribe = (listener: Listener) => {
    this.listeners.add(listener)
    // 즉시 현재 상태 전달
    listener(this.state)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private setState = (patch: Partial<ChatStreamState>) => {
    this.state = { ...this.state, ...patch, updatedAt: Date.now() }
    for (const listener of this.listeners) listener(this.state)
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
      this.setState({ status: 'aborted', isStreaming: false })
    }
  }

  startSessionChat = async (sessionId: string, userMessage: string) => {
    if (this.state.isStreaming) {
      throw new Error('이미 답변 생성 중입니다. 먼저 중단해 주세요.')
    }

    this.abortController = new AbortController()
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
          headers: { 'Content-Type': 'application/json' },
          signal: this.abortController.signal,
        }
      )

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
            this.setState({ status: 'completed', isStreaming: false, streamingPhase: null })
            return
          }

          try {
            const data = JSON.parse(dataStr)

            if (data.usage) {
              const phase = data.usage_phase ? ` (${String(data.usage_phase)})` : ''
              // console.debug 는 브라우저 설정에 따라 숨겨질 수 있어 info 로 출력
              console.info('[TOKENS]' + phase, data.usage)
              continue
            }

            if (data.content) {
              const assistantContent = this.state.assistantContent + String(data.content)
              this.setState({
                assistantContent,
                streamingPhase: 'answer',
              })
              continue
            }

            if (data.function) {
              const toolCall = {
                function: data.function,
                args: data.args || {},
                result: '',
                is_json: false,
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
              const resultText = String(data.result ?? '')

              const toolCalls = this.state.toolCalls.map((tc) =>
                tc.function === functionName ? { ...tc, result: resultText, is_json: isJson } : tc
              )

              const lastFunctionIndex = this.state.functionCallsContent.lastIndexOf(
                `<summary>🔧 <strong>${functionName}</strong></summary>`
              )

              let functionCallsContent = this.state.functionCallsContent
              if (lastFunctionIndex !== -1) {
                const beforeFunction = functionCallsContent.substring(0, lastFunctionIndex)
                const afterFunction = functionCallsContent.substring(lastFunctionIndex)

                const codeBlock = isJson ? `\`\`\`json\n${resultText}\n\`\`\`` : `\`\`\`\n${resultText}\n\`\`\``
                functionCallsContent = beforeFunction + afterFunction.replace('Executing...', codeBlock)
              }

              this.setState({
                toolCalls,
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
              })
              return
            }
          } catch {
            // ignore invalid JSON chunks
          }
        }
      }

      this.setState({ status: 'completed', isStreaming: false, streamingPhase: null })
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        this.setState({ status: 'aborted', isStreaming: false, streamingPhase: null })
        return
      }

      this.setState({
        status: 'error',
        isStreaming: false,
        error: String(error),
        streamingPhase: null,
      })
    } finally {
      this.abortController = null
    }
  }
}

export const chatStreamManager = new ChatStreamManager()
