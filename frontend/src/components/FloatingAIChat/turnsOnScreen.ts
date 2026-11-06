import type { ChatStreamState, FailedTurn } from '@/services/chatStreamManager'
import type { DisplayMessage } from './MessageList'

type Failure = Pick<ChatStreamState, 'error' | 'errorKey' | 'errorArgs'>

const asks = (message: DisplayMessage | undefined, question: string) => message?.role === 'user' && message.content === question

/**
 * The floating chat's list: the saved messages with what they do not hold, as AI Chat keeps it in its bubbles. A failed
 * turn stays where it came, since its letters and error are never saved and its question perhaps not, and so does a
 * stopped one until its letters are saved; the turn going on or just ended stays until the saved messages have it, so
 * its bubbles do not leave the screen and come back.
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

  // a stopped answer whose save has landed, wherever it landed, is the saved messages' from then on
  const lettersSaved = (turn: FailedTurn) =>
    turn.stopped && !!turn.content && saved.some((m, i) => i >= Math.max(shown, turn.askedAt) && m.role === 'assistant' && m.content === turn.content)

  state.failedTurns.forEach((turn, i) => {
    if (lettersSaved(turn)) return
    const next = state.failedTurns[i + 1]?.question ?? state.userMessage
    let at = Math.max(shown, turn.savedBefore)
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
  const answerSaved = questionSaved && saved[at + 1]?.role === 'assistant' && (state.status === 'completed' || state.status === 'aborted')
  savedUpTo(saved.length)
  if (answerSaved) return out

  answer(state.content, state.toolCalls, state.isStreaming)
  failure(state)
  return out
}
