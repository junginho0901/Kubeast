import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TFunction } from 'i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatAnswerMarkdown } from '@/components/ChatAnswerMarkdown'
import { MessageList } from '@/components/FloatingAIChat/MessageList'
import { MessageBubble } from '@/pages/ai-chat/MessageBubble'
import type { Message } from '@/pages/ai-chat/types'
import { ChatStreamManager } from './chatStreamManager'
import { stripToolDetails } from './chatTextUtils'
import { resetSessionState } from './auth'
import { forgetMaskValues, maskValuesFrom, maskValuesOf, rememberMaskValues, revealText } from './maskValues'

// The values behind an answer's numbered placeholders come once with the saved answer and are drawn in their place, in
// both chats; the answer's text, Copy and the page's saves keep the placeholders.

const VALUES = { '<EMAIL_1>': 'ann_x@example.com', '<PHONE_1>': '010-1234-5678' }

describe('the pairs a mask_values event carries', () => {
  it('keeps a numbered placeholder with its value and nothing else', () => {
    expect(maskValuesFrom({ ...VALUES, '<CARD_2>': '4111-1111-1111-1111', '<RRN_1>': '900101-1234567' })).toEqual({
      ...VALUES, '<CARD_2>': '4111-1111-1111-1111', '<RRN_1>': '900101-1234567',
    })
    expect(maskValuesFrom({ '<EMAIL_1>': 'a@b.io', 'EMAIL_2': 'x', '<REDACTED:token>': 'y', '<TOKEN_1>': 'z', '<PHONE_2>': 3, '<CARD_1>': '',
      '<EMAIL_3> ': 'w', '<EMAIL_4>': 'x'.repeat(321) })).toEqual({ '<EMAIL_1>': 'a@b.io' })
    expect(maskValuesFrom({ '<TOKEN_1>': 'z' })).toBeNull()
    expect(maskValuesFrom(null)).toBeNull()
    expect(maskValuesFrom(['<EMAIL_1>'])).toBeNull()
    expect(maskValuesFrom('<EMAIL_1>')).toBeNull()
  })

  it('puts a value in its placeholder place and leaves one without a value', () => {
    expect(revealText('<EMAIL_1> called from <PHONE_1>, then <EMAIL_2>', VALUES)).toBe('ann_x@example.com called from 010-1234-5678, then <EMAIL_2>')
    expect(revealText('<EMAIL_12> and <EMAIL_1x> are other words', VALUES)).toBe('<EMAIL_12> and <EMAIL_1x> are other words')
    expect(revealText('<EMAIL_1>', null)).toBe('<EMAIL_1>')
  })

  it('keeps a saved answer\'s values by its id until they are forgotten, the newest 200', () => {
    forgetMaskValues()
    rememberMaskValues(7, VALUES)
    expect(maskValuesOf(7)).toEqual(VALUES)
    expect(maskValuesOf(8)).toBeUndefined()
    expect(maskValuesOf(undefined)).toBeUndefined()
    for (let id = 100; id < 300; id++) rememberMaskValues(id, VALUES)
    expect(maskValuesOf(7)).toBeUndefined()
    expect(maskValuesOf(100)).toEqual(VALUES)
    forgetMaskValues()
    expect(maskValuesOf(100)).toBeUndefined()
  })

  it('forgets them when the session changes: a sign-out, or someone signing in on the tab without one', () => {
    rememberMaskValues(7, VALUES)
    resetSessionState()
    expect(maskValuesOf(7)).toBeUndefined()
  })
})

describe('an answer whose values came', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    forgetMaskValues()
  })

  const sse = (events: unknown[]) => events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('')

  // The events as the network may hand them over: in pieces cut at `cutAt`, here in the middle of a placeholder.
  function inPieces(body: string, cutAt: string) {
    const at = body.indexOf(cutAt) + cutAt.length / 2
    const pieces = [body.slice(0, at), body.slice(at)]
    return new Response(new ReadableStream({
      pull(controller) {
        const piece = pieces.shift()
        if (piece === undefined) controller.close()
        else controller.enqueue(new TextEncoder().encode(piece))
      },
    }))
  }

  async function asked(body: string, cutAt = '<EMAIL_1>') {
    const saves: unknown[] = []
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes('/ai/sessions/')) return inPieces(body, cutAt)
      saves.push(JSON.parse(String(init.body)))
      return new Response('{"saved":1}')
    }))
    const manager = new ChatStreamManager({ bodyJson: true })
    await manager.startSessionChat('s1', 'who failed?')
    await vi.runAllTimersAsync()
    return { state: manager.getState(), saves, manager }
  }

  const ANSWER = [
    // a placeholder split across two events, and the network piece cut inside the tool result's
    { content: 'User <EMA' }, { content: 'IL_1> failed; ' },
    { function: 'k8s_get_pod_logs', args: { pod_name: 'web-1' }, call_id: 0 },
    { function_result: 'k8s_get_pod_logs', result: 'login user=<EMAIL_1> phone=<PHONE_1>', call_id: 0 },
    { content: 'call <PHONE_1> or <EMAIL_2>.' },
  ]

  it('keeps the placeholders in its text, Copy and the id\'s values beside it, and draws the values in their place', async () => {
    const { state, saves } = await asked(sse([...ANSWER, { mask_values: VALUES, message_id: 42 }, '[DONE]']), 'user=<EMAIL_1>')
    expect(state.status).toBe('completed')
    expect(state.maskValues).toEqual(VALUES)
    expect(maskValuesOf(42)).toEqual(VALUES)
    expect(saves).toEqual([])
    for (const kept of [state.content, stripToolDetails(state.content), JSON.stringify(state.toolCalls)]) {
      expect(kept).not.toContain('ann_x@example.com')
      expect(kept).not.toContain('010-1234-5678')
    }
    expect(state.content).toContain('User <EMAIL_1> failed;')
    expect(stripToolDetails(state.content)).toContain('User <EMAIL_1> failed;')

    const shown = renderToStaticMarkup(createElement(ChatAnswerMarkdown, { content: state.content, values: state.maskValues }))
    expect(shown).toContain('User ann_x@example.com failed;')
    expect(shown).toContain('login user=ann_x@example.com phone=010-1234-5678')
    // a placeholder with no value stays, and a value is letters, not a link or emphasis
    expect(shown).toContain('call 010-1234-5678 or &lt;EMAIL_2&gt;.')
    expect(shown).not.toContain('&lt;EMAIL_1&gt;')
    expect(shown).not.toContain('mailto:')
    expect(shown).not.toContain('<em>')

    const plain = renderToStaticMarkup(createElement(ChatAnswerMarkdown, { content: state.content }))
    expect(plain).toContain('User &lt;EMAIL_1&gt; failed;')
    expect(plain).not.toContain('ann_x@example.com')
  })

  it('a values event that is not one leaves the answer as it came', async () => {
    const { state } = await asked(sse([...ANSWER, { mask_values: { '<TOKEN_1>': 'x' }, message_id: 43 }, { mask_values: 'no' }, '[DONE]']))
    expect(state.maskValues).toBeNull()
    expect(maskValuesOf(43)).toBeUndefined()
  })

  it('an answer cut after its values is saved by the page with its placeholders', async () => {
    const { state, saves } = await asked(sse([...ANSWER, { mask_values: VALUES, message_id: 44 }]))
    expect(state).toMatchObject({ status: 'error', errorKey: 'streamCut' })
    expect(saves).toHaveLength(1)
    const saved = JSON.stringify(saves)
    expect(saved).toContain('User <EMAIL_1> failed;')
    expect(saved).not.toContain('ann_x@example.com')
    expect(saved).not.toContain('010-1234-5678')
  })

  it('the next question starts with no values, and the saved answer keeps its own', async () => {
    const { state, manager } = await asked(sse([...ANSWER, { mask_values: VALUES, message_id: 45 }, '[DONE]']))
    expect(state.maskValues).toEqual(VALUES)
    vi.stubGlobal('fetch', vi.fn(async () => inPieces(sse([{ content: 'Still <EMAIL_1>.' }, '[DONE]']), 'Still')))
    await manager.startSessionChat('s1', 'again?')
    await vi.runAllTimersAsync()
    expect(manager.getState()).toMatchObject({ status: 'completed', content: 'Still <EMAIL_1>.', maskValues: null })
    expect(maskValuesOf(45)).toEqual(VALUES)
  })
})

describe('both chats draw a saved answer with the values its id keeps, until they are forgotten', () => {
  afterEach(() => forgetMaskValues())

  const t = ((key: string) => key) as unknown as TFunction
  const CONTENT = 'User <EMAIL_1> called from <PHONE_1>.'
  const aiChat = (message: Message) =>
    renderToStaticMarkup(createElement(MessageBubble, { message, idx: 0, copyResult: null, onCopy: () => {}, onDownloadJson: async () => ({ kind: 'nothing' as const }), t }))
  const floating = (messages: Parameters<typeof MessageList>[0]['messages']) => renderToStaticMarkup(createElement(MessageList, { messages }))

  const SHOWN = 'User ann_x@example.com called from 010-1234-5678.'
  const PLACEHOLDERS = 'User &lt;EMAIL_1&gt; called from &lt;PHONE_1&gt;.'

  // [surface, draw, what it shows once the values by id are forgotten (a reload, signing out)]
  it.each([
    ['AI Chat, saved', () => aiChat({ id: 42, role: 'assistant', content: CONTENT }), PLACEHOLDERS],
    ['AI Chat, while it comes', () => aiChat({ role: 'assistant', content: CONTENT, isTemporary: true, streamingPhase: 'answer', maskValues: VALUES }), SHOWN],
    ['floating chat, saved', () => floating([{ id: 42, role: 'assistant', content: CONTENT }]), PLACEHOLDERS],
    ['floating chat, while it comes', () => floating([{ role: 'assistant', content: CONTENT, pending: true, maskValues: VALUES }]), SHOWN],
  ])('%s', (_name, draw, afterForgetting) => {
    rememberMaskValues(42, VALUES)
    expect(draw()).toContain(SHOWN)
    forgetMaskValues()
    expect(draw()).toContain(afterForgetting)
  })

  it('another answer, or one read again after a reload, shows its placeholders', () => {
    rememberMaskValues(42, VALUES)
    expect(aiChat({ id: 41, role: 'assistant', content: CONTENT })).toContain(PLACEHOLDERS)
    expect(floating([{ id: 41, role: 'assistant', content: CONTENT }])).toContain(PLACEHOLDERS)
    // the user's own question is never changed
    expect(aiChat({ id: 42, role: 'user', content: CONTENT })).toContain(PLACEHOLDERS)
  })
})
