import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatPanel } from '@/components/FloatingAIChat/ChatPanel'
import { floatingChatStreamManager } from '@/services/floatingChatStreamManager'

// The floating chat's panel as it stands after a turn: the real manager, each fetch answered, the panel drawn over a
// history of saved messages. The manager outlives a panel, as it does on the page, so each test has its own conversation.

let conversation = 0
let session = ''
const REFUSED = 'HTTP 503: audit unavailable'
const CUT = 'The connection closed before the answer finished, so the text above may be incomplete. Ask again for the whole answer.'

const sse = (...events: unknown[]) => events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('')
const refused = () => new Response('{"detail":"audit unavailable"}', { status: 503 })
const answered = (text: string) => new Response(sse({ content: text }, '[DONE]'))
const cut = (text: string) => new Response(sse({ content: text }))

function stillComing(text: string) {
  return (_url: string, init: RequestInit) => new Response(new ReadableStream({
    start(controller) {
      if (text) controller.enqueue(new TextEncoder().encode(sse({ content: text })))
      init.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')))
    },
  }))
}

// one question as the panel sends it: savedBefore = the saved messages on screen when it was sent
async function ask(question: string, answer: Response | ReturnType<typeof stillComing>, savedBefore = 0, conversationId = session) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => (answer instanceof Response ? answer : answer(url, init))))
  const running = floatingChatStreamManager.startSessionChat(conversationId, question, undefined, savedBefore)
  if (answer instanceof Response) {
    await running
    await vi.runAllTimersAsync()
  } else {
    await vi.advanceTimersByTimeAsync(1000)
  }
}

const saved = (...messages: [string, string][]) => messages.map(([role, content], i) => ({ id: i + 1, role, content }))

function panel(history?: ReturnType<typeof saved>, conversationId = session) {
  const client = new QueryClient()
  if (history) client.setQueryData(['floating-session-detail', conversationId], { messages: history })
  const element = createElement(ChatPanel, {
    onClose: () => {},
    getSnapshot: () => ({}) as never,
    consumeContextChanged: () => false,
    visible: true,
    docked: false,
    sessionId: conversationId,
    onSessionIdChange: () => {},
  })
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, element))
}

const answers = (html: string) => html.match(/data-testid="floating-answer"/g)?.length ?? 0

// what the list says, top to bottom
function rows(html: string): string[] {
  const list = html.slice(html.indexOf('data-testid="floating-messages"'), html.indexOf('<textarea'))
  return list.slice(list.indexOf('>') + 1).split(/<[^>]+>/).map((text) => text.trim()).filter(Boolean)
}

beforeEach(() => {
  session = `s${++conversation}`
  vi.useFakeTimers()
  vi.stubGlobal('window', globalThis)
})

afterEach(async () => {
  await floatingChatStreamManager.stop()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the floating chat when an answer does not finish', () => {
  it('a refused request keeps the question and shows why', async () => {
    await ask('how many clusters?', refused())
    const html = panel()
    expect(rows(html)).toEqual(['how many clusters?', REFUSED])
    expect(answers(html)).toBe(0)
  })

  it('a stream cut short keeps the question and its letters, with the error under them', async () => {
    await ask('how many clusters?', cut('Two clusters **so** far'))
    const html = panel()
    expect(html).toContain('Two clusters <strong>so</strong> far')
    expect(rows(html)).toEqual(['how many clusters?', 'Two clusters', 'so', 'far', CUT])
    expect(answers(html)).toBe(1)
    expect(html).toContain('data-testid="floating-copy"')
    expect(html).not.toContain('data-testid="floating-waiting"')
  })

  it('a stream cut short during a tool call keeps its block', async () => {
    const body = ['{"content":"Checking."}', '{"function":"list_clusters","args":{},"call_id":0}'].map((e) => `data: ${e}\n\n`).join('')
    await ask('how many clusters?', new Response(body))
    const html = panel()
    expect(html).toContain('Checking.')
    expect(html).toContain('🔧 <strong>list_clusters</strong>')
    expect(html).toContain('before the answer finished')
  })

  it('an empty 200 keeps the question and says there was no answer', async () => {
    await ask('how many clusters?', new Response(''))
    const html = panel()
    expect(rows(html)).toEqual(['how many clusters?', 'The connection closed without an answer. Ask again.'])
    expect(answers(html)).toBe(0)
  })

  it("a server's refusal after some text keeps the text too", async () => {
    await ask('how many clusters?', new Response(sse({ content: 'Checking.' }, { error: 'AI model call failed' })))
    expect(rows(panel())).toEqual(['how many clusters?', 'Checking.', 'AI model call failed'])
  })

  it('a question the server saved shows once', async () => {
    await ask('how many clusters?', refused())
    expect(rows(panel(saved(['user', 'how many clusters?'])))).toEqual(['how many clusters?', REFUSED])
  })

  it('a failure goes below a history that loaded after the question was sent', async () => {
    await ask('how many clusters?', refused())
    expect(rows(panel(saved(['user', 'older'], ['assistant', 'older answer'])))).toEqual(['older', 'older answer', 'how many clusters?', REFUSED])
  })
})

describe('the floating chat keeps a failed turn when the next question comes', () => {
  it('above the next answer while it comes', async () => {
    await ask('first?', refused())
    await ask('second?', stillComing('Now it works'))
    const html = panel()
    expect(rows(html)).toEqual(['first?', REFUSED, 'second?', 'Now it works'])
    expect(answers(html)).toBe(1)
  })

  it('and once that answer is saved, when the server saved no failed question', async () => {
    await ask('first?', refused())
    await ask('second?', answered('Now it works'))
    expect(rows(panel(saved(['user', 'second?'], ['assistant', 'Now it works'])))).toEqual(['first?', REFUSED, 'second?', 'Now it works'])
  })

  it('and once that answer is saved, when the server saved the failed question too', async () => {
    await ask('first?', cut('Two clusters'))
    await ask('second?', answered('Now it works'))
    expect(rows(panel(saved(['user', 'first?'], ['user', 'second?'], ['assistant', 'Now it works']))))
      .toEqual(['first?', 'Two clusters', CUT, 'second?', 'Now it works'])
  })

  it('with its letters and its tool block', async () => {
    const body = sse({ content: 'Checking.' }, { function: 'list_clusters', args: {}, call_id: 0 })
    await ask('first?', new Response(body))
    await ask('second?', stillComing('Now it works'))
    const html = panel()
    expect(html).toContain('🔧 <strong>list_clusters</strong>')
    expect(html.indexOf('Checking.')).toBeLessThan(html.indexOf('list_clusters'))
    expect(html.indexOf('list_clusters')).toBeLessThan(html.indexOf('before the answer finished'))
    expect(html.indexOf('before the answer finished')).toBeLessThan(html.indexOf('second?'))
    expect(answers(html)).toBe(2)
  })

  it('the same question asked again after a refusal shows twice, with one saved', async () => {
    await ask('why?', refused())
    await ask('why?', answered('Because.'))
    expect(rows(panel(saved(['user', 'why?'], ['assistant', 'Because.'])))).toEqual(['why?', REFUSED, 'why?', 'Because.'])
  })

  it('the same question asked again shows twice, with both saved', async () => {
    await ask('why?', cut('Bec'))
    await ask('why?', answered('Because.'))
    expect(rows(panel(saved(['user', 'why?'], ['user', 'why?'], ['assistant', 'Because.'])))).toEqual(['why?', 'Bec', CUT, 'why?', 'Because.'])
  })

  it('the same question asked again, while its answer comes', async () => {
    await ask('why?', refused())
    await ask('why?', stillComing('Bec'))
    expect(rows(panel())).toEqual(['why?', REFUSED, 'why?', 'Bec'])
  })

  it('in its place between saved turns', async () => {
    await ask('failed?', refused(), 2)
    await ask('third?', answered('Third.'), 2)
    const history = saved(['user', 'first?'], ['assistant', 'First.'], ['user', 'third?'], ['assistant', 'Third.'])
    expect(rows(panel(history))).toEqual(['first?', 'First.', 'failed?', REFUSED, 'third?', 'Third.'])
  })

  it('in its place when its saved question had reached the screen before the next was sent', async () => {
    await ask('failed?', cut('Par'), 2)
    await ask('third?', answered('Third.'), 3)
    const history = saved(['user', 'first?'], ['assistant', 'First.'], ['user', 'failed?'], ['user', 'third?'], ['assistant', 'Third.'])
    expect(rows(panel(history))).toEqual(['first?', 'First.', 'failed?', 'Par', CUT, 'third?', 'Third.'])
  })

  it('two failures in a row stay in the order they came', async () => {
    await ask('one?', refused())
    await ask('two?', cut('Par'))
    await ask('three?', stillComing('Now'))
    expect(rows(panel())).toEqual(['one?', REFUSED, 'two?', 'Par', CUT, 'three?', 'Now'])
  })

  it('a question after a stopped answer keeps the failure before it', async () => {
    await ask('one?', refused())
    await ask('two?', stillComing('Par'))
    await floatingChatStreamManager.stop()
    await vi.runAllTimersAsync()
    await ask('three?', stillComing('Now'), 2)
    expect(rows(panel(saved(['user', 'two?'], ['assistant', 'Par'])))).toEqual(['one?', REFUSED, 'two?', 'Par', 'three?', 'Now'])
  })

  it('a panel opened again shows the same', async () => {
    await ask('first?', refused())
    await ask('second?', stillComing('Now it works'))
    expect(rows(panel())).toEqual(rows(panel()))
    expect(rows(panel())).toEqual(['first?', REFUSED, 'second?', 'Now it works'])
  })

  it('another conversation shows none of it', async () => {
    const other = `${session}-other`
    await ask('first?', refused())
    await ask('elsewhere?', stillComing('Here'), 0, other)
    expect(rows(panel(undefined, other))).toEqual(['elsewhere?', 'Here'])
    expect(rows(panel(saved(['user', 'older'])))).toEqual(['older'])
  })

  it('coming back to a conversation forgets what failed before another', async () => {
    const other = `${session}-other`
    await ask('first?', refused())
    await ask('elsewhere?', answered('Here'), 0, other)
    await ask('back?', stillComing('Now'))
    expect(rows(panel())).toEqual(['back?', 'Now'])
  })
})

describe('the floating chat keeps an answer on screen when it ends', () => {
  it('while it comes, one bubble without Copy', async () => {
    await ask('how many clusters?', stillComing('Two clusters'))
    const html = panel()
    expect(rows(html)).toEqual(['how many clusters?', 'Two clusters'])
    expect(answers(html)).toBe(1)
    expect(html).not.toContain('data-testid="floating-copy"')
  })

  it('a question saved while its answer comes shows once', async () => {
    await ask('how many clusters?', stillComing('Two clusters'))
    expect(rows(panel(saved(['user', 'how many clusters?'])))).toEqual(['how many clusters?', 'Two clusters'])
  })

  it('waiting for the first letter, the three dots', async () => {
    await ask('how many clusters?', stillComing(''))
    const html = panel()
    expect(rows(html)).toEqual(['how many clusters?'])
    expect(html).toContain('data-testid="floating-waiting"')
  })

  it('an answer that ended stays until the saved messages have it', async () => {
    await ask('how many clusters?', answered('Two clusters.'))
    const html = panel()
    expect(rows(html)).toEqual(['how many clusters?', 'Two clusters.'])
    expect(html).toContain('data-testid="floating-copy"')
    expect(html).not.toContain('HTTP')
    expect(html).not.toContain('before the answer finished')
  })

  it('and then shows once, as saved', async () => {
    await ask('how many clusters?', answered('Two clusters.'))
    expect(rows(panel(saved(['user', 'how many clusters?'], ['assistant', 'Saved: two clusters.'])))).toEqual(['how many clusters?', 'Saved: two clusters.'])
  })

  it('while only its question has been saved it stays', async () => {
    await ask('how many clusters?', answered('Two clusters.'))
    expect(rows(panel(saved(['user', 'how many clusters?'])))).toEqual(['how many clusters?', 'Two clusters.'])
  })

  it('the same question answered earlier does not stand for it', async () => {
    await ask('why?', answered('Because.'), 2)
    expect(rows(panel(saved(['user', 'why?'], ['assistant', 'Earlier.'])))).toEqual(['why?', 'Earlier.', 'why?', 'Because.'])
  })

  it('a stopped answer stays with every letter that came, until the saved messages have it', async () => {
    await ask('how many clusters?', stillComing('part of it'))
    await floatingChatStreamManager.stop()
    await vi.runAllTimersAsync()
    const html = panel()
    expect(rows(html)).toEqual(['how many clusters?', 'part of it'])
    expect(html).not.toContain('data-testid="floating-waiting"')
    expect(rows(panel(saved(['user', 'how many clusters?'], ['assistant', 'part of it'])))).toEqual(['how many clusters?', 'part of it'])
  })

  it('an answer stopped before its first letter keeps the question and drops the dots', async () => {
    await ask('how many clusters?', stillComing(''))
    await floatingChatStreamManager.stop()
    await vi.runAllTimersAsync()
    const html = panel()
    expect(rows(html)).toEqual(['how many clusters?'])
    expect(html).not.toContain('data-testid="floating-waiting"')
    expect(rows(panel(saved(['user', 'how many clusters?'])))).toEqual(['how many clusters?'])
  })
})
