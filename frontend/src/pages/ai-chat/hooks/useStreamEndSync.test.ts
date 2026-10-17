import { describe, expect, it } from 'vitest'
import { markStoppedAnswer, settleMessages } from './useStreamEndSync'
import type { Message } from '../types'

const user: Message = { role: 'user', content: '안녕', isTemporary: true }
const placeholder: Message = { role: 'assistant', content: '', isTemporary: true, streamingPhase: 'waiting' }

describe('settleMessages', () => {
  it('drops the empty assistant placeholder when the turn ended in an error', () => {
    const out = settleMessages([{ id: 1, role: 'assistant', content: 'earlier' }, user, placeholder], true)
    expect(out).toEqual([{ id: 1, role: 'assistant', content: 'earlier', isTemporary: false }, { ...user, isTemporary: false }])
  })

  it('keeps a placeholder that already has text or tool calls, and every bubble of a completed turn', () => {
    const partial: Message = { ...placeholder, content: 'part of an answer' }
    const tools: Message = { ...placeholder, toolCalls: [{ name: 'k8s_get_resources' }] }
    expect(settleMessages([user, partial], true).map((m) => m.content)).toEqual(['안녕', 'part of an answer'])
    expect(settleMessages([user, tools], true)).toHaveLength(2)
    expect(settleMessages([user, placeholder], false).every((m) => m.isTemporary === false)).toBe(true)
    expect(settleMessages([user, placeholder], false)).toHaveLength(2)
  })
})

describe('markStoppedAnswer', () => {
  it('marks the last assistant answer as stopped and leaves the rest', () => {
    const msgs = [
      { role: 'user' as const, content: 'q1' },
      { role: 'assistant' as const, content: 'a1', usage: { prompt_tokens: 10, completion_tokens: 2 } },
      { role: 'user' as const, content: 'q2' },
      { role: 'assistant' as const, content: 'part of a2' },
    ]
    const out = markStoppedAnswer(msgs)
    expect(out[3].usage).toEqual({ stopped: true })
    expect(out[1].usage).toEqual({ prompt_tokens: 10, completion_tokens: 2 })
    expect(out.slice(0, 3)).toEqual(msgs.slice(0, 3))
  })

  it('marks nothing when the stopped turn has no answer text yet', () => {
    const msgs = [{ role: 'user' as const, content: 'q' }, { role: 'assistant' as const, content: '' }]
    expect(markStoppedAnswer(msgs)).toBe(msgs)
  })
})
