import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import { MessageBubble } from './MessageBubble'
import type { Message } from './types'

const t = ((key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key) as unknown as TFunction

function bubble(message: Message) {
  return renderToStaticMarkup(createElement(MessageBubble, {
    message, idx: 0, copyResult: null, onCopy: () => {}, onDownloadJson: async () => ({ ok: true }) as never, t,
  }))
}

describe('AI Chat bubble of an answer before its first letter', () => {
  it('says it waits for its turn while the server has it queued', () => {
    const html = bubble({ role: 'assistant', content: '', isTemporary: true, streamingPhase: 'waiting', queued: true })
    expect(html).toContain('data-testid="chat-waiting-turn"')
    expect(html).toContain('Waiting for a turn — another question is running')
  })

  it('shows the dots alone once the run starts', () => {
    const html = bubble({ role: 'assistant', content: '', isTemporary: true, streamingPhase: 'waiting', queued: false })
    expect(html).toContain('animate-bounce')
    expect(html).not.toContain('data-testid="chat-waiting-turn"')
  })
})
