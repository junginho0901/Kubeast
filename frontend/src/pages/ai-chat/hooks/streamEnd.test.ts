/* eslint-disable react-hooks/rules-of-hooks -- the hooks run as plain functions here: react's effects and refs are stood in below */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TFunction } from 'i18next'
import { ChatStreamManager, type ChatStreamState } from '@/services/chatStreamManager'
import { useChatStreamSync } from '../useChatStreamSync'
import type { Message } from '../types'
import { useSessionDetailSync } from './useSessionDetailSync'
import { useStreamEndSync } from './useStreamEndSync'

// AI Chat's bubbles when an answer ends, through the page's own hooks: effects run where they are called, refs start
// from `refs`, and the session query answers with `query.data`.

const refs = vi.hoisted(() => [] as unknown[])
const query = vi.hoisted(() => ({ data: undefined as unknown }))

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useEffect: (effect: () => void) => {
    effect()
  },
  useRef: (value: unknown) => ({ current: refs.length ? refs.shift() : value }),
}))

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: () => {}, refetchQueries: () => {} }),
  useQuery: () => ({ data: query.data }),
}))

const t = ((key: string, values?: { error?: string; defaultValue?: string }) => values?.defaultValue ?? `${key}: ${values?.error}`) as unknown as TFunction
const SESSION = 's1'
const QUESTION = 'how many clusters?'

function screen(start: Message[]) {
  let messages = start
  return {
    get: () => messages,
    set: ((next: Message[] | ((prev: Message[]) => Message[])) => {
      messages = typeof next === 'function' ? next(messages) : next
    }) as React.Dispatch<React.SetStateAction<Message[]>>,
  }
}

const asked = (): Message[] => [
  { role: 'user', content: QUESTION, isTemporary: true },
  { role: 'assistant', content: '', isTemporary: true, streamingPhase: 'waiting' },
]

// the page's two hooks on one state, in the order the page calls them
function draw(state: ChatStreamState, bubbles: ReturnType<typeof screen>) {
  useChatStreamSync({ streamState: state, selectedSessionId: SESSION, viewSessionId: SESSION, setMessages: bubbles.set as never })
  refs.push('streaming')
  useStreamEndSync({ streamState: state, selectedSessionId: SESSION, setPendingFinalSyncSessionId: () => {}, setMessages: bubbles.set, t })
}

async function ended(response: Response, each: boolean) {
  vi.useFakeTimers()
  vi.stubGlobal('window', globalThis)
  vi.stubGlobal('fetch', vi.fn(async () => response))
  const manager = new ChatStreamManager({ bodyJson: true })
  const bubbles = screen(asked())
  manager.subscribe((state) => {
    if (each && state.status === 'streaming') draw(state, bubbles)
  })
  await manager.startSessionChat(SESSION, QUESTION)
  await vi.runAllTimersAsync()
  // React may draw only the last of the states one tick set
  const state = manager.getState()
  draw(state, bubbles)
  return { state, messages: bubbles.get() }
}

const text = (messages: Message[]) => messages.map((m) => `${m.role}: ${m.content}`)

describe.each([
  ['each state drawn', true],
  ['only the last state drawn', false],
])('AI Chat when an answer does not finish (%s)', (_name, each) => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('a refused request keeps the question and adds one error bubble', async () => {
    const { messages } = await ended(new Response('{"detail":"audit unavailable"}', { status: 503 }), each)
    expect(text(messages)).toEqual([`user: ${QUESTION}`, 'assistant: HTTP 503: audit unavailable'])
    expect(messages.every((m) => !m.isTemporary)).toBe(true)
  })

  it('a stream cut short keeps the question and its letters, with one error bubble under them', async () => {
    const { messages, state } = await ended(new Response('data: {"content":"Two clusters so far"}\n\n'), each)
    expect(state.status).toBe('error')
    expect(text(messages).slice(0, 2)).toEqual([`user: ${QUESTION}`, 'assistant: Two clusters so far'])
    expect(messages).toHaveLength(3)
    expect(messages[2].content).toContain('before the answer finished')
    expect(messages.every((m) => !m.isTemporary)).toBe(true)
  })

  it('a stream cut short during a tool call keeps its block', async () => {
    const body = ['{"content":"Checking."}', '{"function":"list_clusters","args":{},"call_id":0}'].map((e) => `data: ${e}\n\n`).join('')
    const { messages } = await ended(new Response(body), each)
    expect(messages[1].content).toContain('Checking.')
    expect(messages[1].content).toContain('🔧 <strong>list_clusters</strong>')
    expect(messages[1].toolCalls?.map((tc) => tc.function)).toEqual(['list_clusters'])
    expect(messages).toHaveLength(3)
    expect(messages[2].content).toContain('before the answer finished')
  })

  it('an empty 200 keeps the question and drops the waiting bubble', async () => {
    const { messages } = await ended(new Response(''), each)
    expect(messages).toHaveLength(2)
    expect(messages[0].content).toBe(QUESTION)
    expect(messages[1].content).toContain('without an answer')
  })

  it('an answer that ended keeps its bubble, with no error', async () => {
    const { messages, state } = await ended(new Response('data: {"content":"Two clusters."}\n\ndata: [DONE]\n\n'), true)
    expect(state.status).toBe('completed')
    expect(text(messages)).toEqual([`user: ${QUESTION}`, 'assistant: Two clusters.'])
  })
})

describe('AI Chat after an answer failed', () => {
  afterEach(() => {
    refs.length = 0
    vi.unstubAllGlobals()
  })

  const failed = {
    status: 'error',
    isStreaming: false,
    sessionId: SESSION,
    userMessage: QUESTION,
    content: '',
    toolCalls: [],
    streamingPhase: null,
    error: 'HTTP 503: audit unavailable',
    errorKey: 'streamHttp',
    errorArgs: { status: 503, detail: 'audit unavailable' },
    updatedAt: 1,
  } satisfies ChatStreamState

  it('a later render with the failed state adds no bubble', () => {
    const before: Message[] = [{ role: 'user', content: QUESTION }, { role: 'assistant', content: 'the error' }]
    const bubbles = screen(before)
    useChatStreamSync({ streamState: failed, selectedSessionId: SESSION, viewSessionId: SESSION, setMessages: bubbles.set as never })
    expect(bubbles.get()).toEqual(before)
  })

  // The chat request can fail before the new conversation's first read comes back.
  it.each([
    ['nothing saved', []],
    ['the question saved', [{ id: 1, role: 'user', content: QUESTION }]],
  ])('a first read of the conversation with %s does not take the question and the error off the screen', (_name, saved) => {
    const shown: Message[] = [{ role: 'user', content: QUESTION }, { role: 'assistant', content: 'the error' }]
    const bubbles = screen(shown)
    query.data = { id: SESSION, messages: saved }
    useSessionDetailSync({
      selectedSessionId: SESSION,
      stoppedSessionId: null,
      pendingFinalSyncSessionId: null,
      lastLoadedSessionId: null,
      setLastLoadedSessionId: () => {},
      setPendingFinalSyncSessionId: () => {},
      setViewSessionId: () => {},
      setMessages: bubbles.set,
      streamStateRef: { current: failed },
      messagesRef: { current: shown },
    })
    expect(bubbles.get()).toEqual(shown)
  })

  it('opening the conversation again shows what was saved', () => {
    const bubbles = screen([])
    query.data = { id: SESSION, messages: [{ id: 1, role: 'user', content: QUESTION }] }
    useSessionDetailSync({
      selectedSessionId: SESSION,
      stoppedSessionId: null,
      pendingFinalSyncSessionId: null,
      lastLoadedSessionId: 'other',
      setLastLoadedSessionId: () => {},
      setPendingFinalSyncSessionId: () => {},
      setViewSessionId: () => {},
      setMessages: bubbles.set,
      streamStateRef: { current: failed },
      messagesRef: { current: [] },
    })
    expect(text(bubbles.get())).toEqual([`user: ${QUESTION}`])
  })
})
