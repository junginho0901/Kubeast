import type { ChatStreamState, FailedTurn } from '@/services/chatStreamManager'
import type { DisplayMessage } from './MessageList'

type Failure = Pick<ChatStreamState, 'error' | 'errorKey' | 'errorArgs'>

const asks = (message: DisplayMessage | undefined, question: string) => message?.role === 'user' && message.content === question

// Whether this account cannot have the conversation (another account's, or deleted): reading it said so, or the chat did.
export function conversationGone(readError: unknown, state: Pick<ChatStreamState, 'errorKey' | 'sessionId'>, sessionId: string | null): boolean {
  const status = (readError as { response?: { status?: number } } | null)?.response?.status
  return status === 404 || status === 403 || (state.sessionId === sessionId && state.errorKey === 'sessionNotFound')
}

// A conversation that is gone is left for a new one, except while the turn that found out is on screen: its question and
// error stay until the next question, which starts the new conversation.
export function forgetsConversation(state: Pick<ChatStreamState, 'status' | 'sessionId'>, sessionId: string | null): boolean {
  return !(state.status === 'error' && state.sessionId === sessionId)
}

/**
 * The floating chat's list: the saved messages with what they do not hold, as AI Chat keeps it in its bubbles. A failed
 * turn stays where it came, since its error is never saved, its question perhaps not, and its letters only if the server
 * got them, and so does a stopped one until its letters are saved; the turn going on or just ended stays until the saved
 * messages have it, so its bubbles do not leave the screen and come back.
 */
export function turnsOnScreen(saved: DisplayMessage[], state: ChatStreamState, errorText: (failure: Failure) => string): DisplayMessage[] {
  const out: DisplayMessage[] = []
  let shown = 0
  const savedUpTo = (end: number) => {
    out.push(...saved.slice(shown, end))
    shown = Math.max(shown, end)
  }
  const answer = (content: string, toolCalls: unknown[], pending = false) => {
    if (content || pending) out.push({ role: 'assistant', content, toolCalls: toolCalls.length > 0 ? toolCalls : undefined, pending })
  }
  const failure = (turn: Failure) => {
    if (turn.error) out.push({ role: 'error', content: errorText(turn) })
  }

  // Where the saved messages have the letters of a turn, or -1: a stopped answer's save lands wherever it lands, a failed
  // one the server wrote comes marked under its question, and letters read the same when a stream was cut after the save.
  const savedLetters = (turn: FailedTurn) => {
    if (!turn.content) return -1
    const from = Math.max(shown, turn.askedAt)
    return saved.findIndex((m, i) => i >= from && m.role === 'assistant'
      && (m.content === turn.content || (!turn.stopped && !!m.failed && asks(saved[i - 1], turn.question))))
  }

  state.failedTurns.forEach((turn, i) => {
    const letters = savedLetters(turn)
    if (letters !== -1) {
      if (turn.error) {
        savedUpTo(letters + 1)
        failure(turn)
      }
      return
    }
    const next = state.failedTurns[i + 1]?.question ?? state.userMessage
    // It came just before the next question. The list may be behind the count taken when that went out, so what it holds
    // above the first later question, or all of it while none is saved, came before this turn.
    const from = Math.max(shown, turn.savedBefore)
    const later = [...state.failedTurns.slice(i + 1).map((t) => t.question), state.userMessage]
    const laterAt = saved.findIndex((m, at) => at >= from && m.role === 'user' && later.includes(m.content))
    let at = laterAt !== -1 ? laterAt : Math.max(from, saved.length)
    // its saved question had reached the screen before the next was sent
    const reachedScreen = at > shown && asks(saved[at - 1], turn.question)
    if (reachedScreen) at--
    savedUpTo(at)
    // asked again: a single saved copy that reached the screen only later is the later turn's, which has the answer under it
    if (asks(saved[at], turn.question) && (reachedScreen || next !== turn.question || asks(saved[at + 1], turn.question))) savedUpTo(at + 1)
    else out.push({ role: 'user', content: turn.question })
    answer(turn.content, turn.toolCalls)
    failure(turn)
  })

  const question = state.userMessage
  if (state.status === 'idle' || question === null) {
    savedUpTo(saved.length)
    return out
  }

  const from = Math.max(shown, state.savedBefore)
  let at = saved.length - 1
  while (at >= from && !asks(saved[at], question)) at--
  const questionSaved = at >= from
  savedUpTo(questionSaved ? at + 1 : saved.length)
  if (!questionSaved) out.push({ role: 'user', content: question, pending: state.isStreaming })
  const answerSaved = questionSaved && saved[at + 1]?.role === 'assistant' && !state.isStreaming
  savedUpTo(saved.length)
  if (!answerSaved) answer(state.content, state.toolCalls, state.isStreaming)
  failure(state)
  return out
}
