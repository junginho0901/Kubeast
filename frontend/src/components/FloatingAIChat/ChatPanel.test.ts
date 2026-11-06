import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatPanel } from '@/components/FloatingAIChat/ChatPanel'
import { floatingChatStreamManager } from '@/services/floatingChatStreamManager'

// The floating chat's panel as it stands once an answer has ended: the real manager, one fetch answered, the panel drawn.

const SESSION = 's1'

async function panelAfter(response: Response) {
  vi.useFakeTimers()
  vi.stubGlobal('window', globalThis)
  vi.stubGlobal('fetch', vi.fn(async () => response))
  await floatingChatStreamManager.startSessionChat(SESSION, 'how many clusters?')
  await vi.runAllTimersAsync()
  const panel = createElement(ChatPanel, {
    onClose: () => {},
    getSnapshot: () => ({}) as never,
    consumeContextChanged: () => false,
    visible: true,
    docked: false,
    sessionId: SESSION,
    onSessionIdChange: () => {},
  })
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, panel))
}

const answers = (html: string) => html.match(/data-testid="floating-answer"/g)?.length ?? 0

describe('the floating chat when an answer does not finish', () => {
  afterEach(async () => {
    await floatingChatStreamManager.stop()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('a refused request keeps the question and shows why', async () => {
    const html = await panelAfter(new Response('{"detail":"audit unavailable"}', { status: 503 }))
    expect(html).toContain('how many clusters?')
    expect(html).toContain('HTTP 503: audit unavailable')
    expect(answers(html)).toBe(0)
  })

  it('a stream cut short keeps the question and its letters, with the error under them', async () => {
    const html = await panelAfter(new Response('data: {"content":"Two clusters **so** far"}\n\n'))
    expect(html).toContain('how many clusters?')
    expect(html).toContain('Two clusters <strong>so</strong> far')
    expect(answers(html)).toBe(1)
    expect(html).toContain('before the answer finished')
    expect(html.indexOf('Two clusters')).toBeLessThan(html.indexOf('before the answer finished'))
    expect(html).toContain('data-testid="floating-copy"')
    expect(html).not.toContain('data-testid="floating-waiting"')
  })

  it('a stream cut short during a tool call keeps its block', async () => {
    const body = ['{"content":"Checking."}', '{"function":"list_clusters","args":{},"call_id":0}'].map((e) => `data: ${e}\n\n`).join('')
    const html = await panelAfter(new Response(body))
    expect(html).toContain('Checking.')
    expect(html).toContain('🔧 <strong>list_clusters</strong>')
    expect(html).toContain('before the answer finished')
  })

  it('an empty 200 keeps the question and says there was no answer', async () => {
    const html = await panelAfter(new Response(''))
    expect(html).toContain('how many clusters?')
    expect(html).toContain('without an answer')
    expect(answers(html)).toBe(0)
  })

  it("a server's refusal after some text keeps the text too", async () => {
    const body = ['{"content":"Checking."}', '{"error":"AI model call failed"}'].map((e) => `data: ${e}\n\n`).join('')
    const html = await panelAfter(new Response(body))
    expect(html).toContain('Checking.')
    expect(html).toContain('AI model call failed')
  })

  it('an answer that ended draws nothing of its own: the saved messages do', async () => {
    const html = await panelAfter(new Response('data: {"content":"Two clusters."}\n\ndata: [DONE]\n\n'))
    expect(html).not.toContain('Two clusters.')
    expect(html).not.toContain('HTTP')
    expect(html).not.toContain('before the answer finished')
  })
})
