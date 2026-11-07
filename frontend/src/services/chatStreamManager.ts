import { getAuthHeaders, handleUnauthorized } from '@/services/auth'
import { closingFence } from '@/services/chatTextUtils'
import { clusterHeaders } from '@/services/clusterRef'
import { accessSection } from '@/services/toolAccess'

export type StreamingPhase = 'waiting' | 'tools' | 'answer'

export type ChatStreamStatus = 'idle' | 'streaming' | 'completed' | 'aborted' | 'error'

// A turn of this conversation that failed before the current one. The server saves none of its letters or its error,
// perhaps not its question, so a screen drawn from the saved messages has them only from here.
export interface FailedTurn {
  question: string
  content: string
  toolCalls: any[]
  error: string | null
  errorKey: string | null
  errorArgs: Record<string, unknown> | null
  // how many saved messages the screen had when the next question was sent
  savedBefore: number
}

export interface ChatStreamState {
  status: ChatStreamStatus
  isStreaming: boolean
  sessionId: string | null
  userMessage: string | null
  // The answer as it came: the model's text and the tool blocks in order (the order the server saves)
  content: string
  toolCalls: any[]
  streamingPhase: StreamingPhase | null
  error: string | null
  // A refusal the server writes for the screen (token budget): catalog key and values (utils/chatError)
  errorKey: string | null
  errorArgs: Record<string, unknown> | null
  // how many saved messages the screen had when this question was sent
  savedBefore: number
  failedTurns: FailedTurn[]
  updatedAt: number
}

type Listener = (state: ChatStreamState) => void

const initialState: ChatStreamState = {
  status: 'idle',
  isStreaming: false,
  sessionId: null,
  userMessage: null,
  content: '',
  toolCalls: [],
  streamingPhase: null,
  error: null,
  errorKey: null,
  errorArgs: null,
  savedBefore: 0,
  failedTurns: [],
  updatedAt: Date.now(),
}

const RESULT_PLACEHOLDER = 'Executing...'

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

${RESULT_PLACEHOLDER}

</details>

</details>

`
}

// Index of the tool call a result belongs to: the one with its call_id, else the first call of that tool without a
// result yet (an older server sends no call_id). -1 = none.
export function resultTarget(toolCalls: any[], functionName: string, callId: unknown): number {
  if (typeof callId === 'number') {
    const byId = toolCalls.findIndex((tc) => tc?.call_id === callId)
    if (byId !== -1) return byId
  }
  return toolCalls.findIndex((tc) => tc?.function === functionName && !tc.result)
}

// The content with a tool block after it: the block starts on a line of its own below the text so far (markdown
// reads <details> as a block only there), and below a code block the text left open, closed here as the saved answer
// closes it (ai-service streaming.answer_markdown).
export function appendToolBlock(content: string, block: string): string {
  const before = content.replace(/\s+$/, '')
  if (!before) return block
  const closing = closingFence(before)
  return `${before}${closing ? `\n${closing}` : ''}\n\n${block}`
}

// The content with the placeholder at `at` replaced by a result; a result already there stays.
export function withToolResult(content: string, at: number, result: string): string {
  if (!content.startsWith(RESULT_PLACEHOLDER, at)) return content
  return content.substring(0, at) + result + content.substring(at + RESULT_PLACEHOLDER.length)
}

// The backticks around a tool result: more than its longest run, so no line of it can close the code block
// (ai-service formatters.code_fence writes the same; keep the two equal).
export function codeFence(text: string): string {
  let longest = 2
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return '`'.repeat(longest + 1)
}

// The content with what goes under the name of the tool block starting at `at` (the 🔐 line and its requests), where the saved answer has it.
export function withToolAccess(content: string, at: number, line: string): string {
  const end = content.indexOf('</summary>\n', at)
  if (!line || end === -1) return content
  const cut = end + '</summary>\n'.length
  return `${content.substring(0, cut)}\n${line}\n${content.substring(cut)}`
}

// What a refused chat request says: its status and the server's reason. A body that is not the server's JSON (a proxy's
// page) has nothing to show.
async function refusal(response: Response): Promise<Partial<ChatStreamState>> {
  const { status } = response
  const body = await response.text()
  let detail = ''
  try {
    const parsed = JSON.parse(body)?.detail
    if (typeof parsed === 'string') detail = parsed.slice(0, 300)
  } catch {
    // not JSON
  }
  return detail
    ? { error: `HTTP ${status}: ${detail}`, errorKey: 'streamHttp', errorArgs: { status, detail } }
    : { error: `HTTP ${status}`, errorKey: 'streamHttpStatus', errorArgs: { status } }
}

const STREAM_CUT = 'The connection closed before the answer finished, so the text above may be incomplete. Ask again for the whole answer.'
const STREAM_EMPTY = 'The connection closed without an answer. Ask again.'

export interface ChatStreamManagerOptions {
  /**
   * 요청 URL 템플릿. `{sessionId}` 플레이스홀더가 있으면 인코딩된 sessionId 로 치환된다.
   * 기본: `/api/v1/ai/sessions/{sessionId}/chat` (기존 싱글톤 동작).
   */
  endpoint?: string
  /**
   * `true` 면 message 를 JSON body 로 전송. `false` 면 `?message=...` 쿼리 파라미터 —
   * 그 경우 사용자가 쓴 문장이 게이트웨이·서버 접근 로그와 브라우저 기록에 남으므로
   * 두 매니저 모두 `true` 로 만든다.
   */
  bodyJson?: boolean
  /**
   * 요청마다 동적으로 추가할 헤더 (예: 멀티클러스터 PR 에서 `X-Cluster-Name`).
   */
  extraHeaders?: () => Record<string, string>
}

export class ChatStreamManager {
  private state: ChatStreamState = initialState
  private listeners = new Set<Listener>()
  private abortController: AbortController | null = null
  private readonly options: ChatStreamManagerOptions

  // 타자기 효과: 도착한 텍스트를 큐에 넣고 RAF로 적응형 배치 드레인
  private _charQueue: string[] = []
  private _typewriterTimer: number | null = null
  private _streamDone = false          // SSE [DONE] 수신 여부
  private _pendingDonePatch: Partial<ChatStreamState> | null = null
  // Where each tool block of this answer starts and where its result goes. Kept, not read back from the text: a result,
  // the arguments or the answer can hold the same words.
  private _toolBlocks: { start: number; resultAt: number }[] = []
  private static readonly TICK_MS = 16 // 드레인 간격 (ms) — one screen refresh

  constructor(options: ChatStreamManagerOptions = {}) {
    this.options = options
  }

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
    const batch = Math.max(1, Math.ceil(this._charQueue.length / 4))
    const chars = this._charQueue.splice(0, batch).join('')
    this.state = {
      ...this.state,
      content: this.state.content + chars,
      streamingPhase: 'answer',
      updatedAt: Date.now(),
    }
    this.notify()
  }

  /** 큐에 남은 글자 전부 즉시 반영 (abort 때, 그리고 도구 블록 앞 — 도구 앞에 쓴 글이 블록 위에 남게) */
  private _flushQueue = () => {
    if (this._charQueue.length === 0) return
    const remaining = this._charQueue.join('')
    this._charQueue.length = 0
    this.state = {
      ...this.state,
      content: this.state.content + remaining,
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

  // The answer failed: the letters that came stay in content, and an answer the user already stopped stays stopped.
  private _fail = (patch: Partial<ChatStreamState>) => {
    if (this.state.status !== 'streaming') return
    this.setState({ status: 'error', isStreaming: false, streamingPhase: null, ...patch }, true)
  }

  // The content with the n-th tool's result and 🔐 line in its block, once; the blocks after it move by what went in.
  private _withToolOutcome = (n: number, result: string, access: string): string => {
    const content = this.state.content
    const block = this._toolBlocks[n]
    if (!block || block.resultAt === -1) return content
    const { start, resultAt } = block
    const filled = withToolAccess(withToolResult(content, resultAt, result), start, access)
    const grew = filled.length - content.length
    this._toolBlocks = this._toolBlocks.map((other) => {
      if (other === block) return { start, resultAt: -1 }
      if (other.start < start) return other
      return { start: other.start + grew, resultAt: other.resultAt === -1 ? -1 : other.resultAt + grew }
    })
    return filled
  }

  // The failed turns of a conversation as its next question is sent: the one that just failed joins them.
  private _failedTurnsBefore = (sessionId: string, savedMessages: number): FailedTurn[] => {
    const { status, userMessage, content, toolCalls, error, errorKey, errorArgs, failedTurns } = this.state
    if (this.state.sessionId !== sessionId) return []
    if (status !== 'error' || userMessage === null) return failedTurns
    return [...failedTurns, { question: userMessage, content, toolCalls, error, errorKey, errorArgs, savedBefore: savedMessages }]
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

  startSessionChat = async (
    sessionId: string,
    userMessage: string,
    extraBody?: Record<string, unknown>,
    savedMessages = 0,
  ) => {
    if (this.state.isStreaming) {
      throw new Error('이미 답변 생성 중입니다. 먼저 중단해 주세요.')
    }

    this.abortController = new AbortController()
    this._stopTypewriter()
    this._charQueue.length = 0
    this._streamDone = false
    this._pendingDonePatch = null
    this._toolBlocks = []
    this.setState({
      status: 'streaming',
      isStreaming: true,
      sessionId,
      userMessage,
      content: '',
      toolCalls: [],
      streamingPhase: 'waiting',
      error: null,
      errorKey: null,
      errorArgs: null,
      savedBefore: savedMessages,
      failedTurns: this._failedTurnsBefore(sessionId, savedMessages),
    })

    try {
      const endpointTemplate =
        this.options.endpoint ?? '/api/v1/ai/sessions/{sessionId}/chat'
      const endpoint = endpointTemplate.replace(
        '{sessionId}',
        encodeURIComponent(sessionId),
      )
      const useBodyJson = this.options.bodyJson === true
      const extraHeaders = this.options.extraHeaders?.() ?? {}

      const url = useBodyJson
        ? endpoint
        : `${endpoint}?message=${encodeURIComponent(userMessage)}`

      const init: RequestInit = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders(),
          ...extraHeaders,
        },
        signal: this.abortController.signal,
      }

      if (useBodyJson) {
        init.body = JSON.stringify({ message: userMessage, ...(extraBody ?? {}) })
      }

      const response = await fetch(url, init)

      if (response.status === 401) {
        handleUnauthorized()
        throw new Error('Unauthorized')
      }

      if (!response.ok) {
        this._fail(await refusal(response))
        return
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

            if (data.approval_required) {
              // H2: the write tool was parked; attach the approval to the tool
              // call so the message renders an approve/reject card.
              const approvalId = String(data.approval_required)
              const functionName = String(data.function || '')
              let attached = false
              const toolCalls = this.state.toolCalls.map((tc) => {
                if (!attached && tc.function === functionName && !tc.approval_id) {
                  attached = true
                  return { ...tc, approval_id: approvalId, approval_status: 'pending', cluster: data.cluster, expires_at: data.expires_at }
                }
                return tc
              })
              this.setState({ toolCalls, streamingPhase: 'tools' })
              continue
            }

            if (data.function) {
              const toolCall = {
                function: data.function,
                args: data.args || {},
                result: '',
                is_json: false,
                is_yaml: false,
                ...(typeof data.call_id === 'number' ? { call_id: data.call_id } : {}),
              }

              this._flushQueue()
              const block = buildToolCallBlock(data.function, data.args || {})
              const content = appendToolBlock(this.state.content, block)
              const start = content.length - block.length
              this._toolBlocks.push({ start, resultAt: start + block.lastIndexOf(RESULT_PLACEHOLDER) })
              this.setState({
                toolCalls: [...this.state.toolCalls, toolCall],
                content,
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

              // The call this result answers: by its number, else the oldest of that tool still waiting.
              const target = resultTarget(this.state.toolCalls, functionName, data.call_id)
              const mergedToolCalls = this.state.toolCalls.map((tc, i) =>
                i === target
                  ? {
                      ...tc,
                      result: resultText,
                      is_json: isJson,
                      is_yaml: isYaml,
                      ...(displayText ? { display: displayText, display_format: displayFormat } : {}),
                      ...(data.chart ? { chart: data.chart } : {}),
                      ...(data.access ? { access: data.access } : {}),
                      ...(data.requests ? { requests: data.requests } : {}),
                    }
                  : tc
              )

              const bodyText = displayText || resultText
              const fence = codeFence(bodyText)
              const language = displayText ? '' : isYaml ? 'yaml' : isJson ? 'json' : ''
              const codeBlock = `${fence}${language}\n${bodyText}\n${fence}`

              // Text still queued for the typewriter came after this call's block, so it stays in the queue.
              this.setState({
                toolCalls: mergedToolCalls,
                content: this._withToolOutcome(target, codeBlock, accessSection(data.access, data.requests)),
                streamingPhase: 'tools',
              })
              continue
            }

            if (data.error) {
              this._fail({
                error: String(data.error),
                errorKey: typeof data.error_key === 'string' ? data.error_key : null,
                errorArgs: data.error_args && typeof data.error_args === 'object' ? data.error_args : null,
              })
              return
            }
          } catch {
            // ignore invalid JSON chunks
          }
        }
      }

      // Every answer the server finishes ends with [DONE] or an error event: a stream without either was cut off.
      if (buffer.trim() === 'data: [DONE]') {
        this._finishWhenDrained({ status: 'completed', isStreaming: false, streamingPhase: null })
      } else if (this.state.content || this._charQueue.length > 0) {
        this._fail({ error: STREAM_CUT, errorKey: 'streamCut' })
      } else {
        this._fail({ error: STREAM_EMPTY, errorKey: 'streamEmpty' })
      }
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        this.setState({ status: 'aborted', isStreaming: false, streamingPhase: null }, true)
        return
      }

      this._fail({ error: String(error) })
    } finally {
      this.abortController = null
    }
  }
}

export const chatStreamManager = new ChatStreamManager({ extraHeaders: clusterHeaders, bodyJson: true })
