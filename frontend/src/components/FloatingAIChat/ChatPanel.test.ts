import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatPanel } from '@/components/FloatingAIChat/ChatPanel'
import { conversationGone, forgetsConversation } from '@/components/FloatingAIChat/turnsOnScreen'
import { floatingChatStreamManager } from '@/services/floatingChatStreamManager'
import chatPanelSrc from '@/components/FloatingAIChat/ChatPanel.tsx?raw'

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

function panel(history?: Array<ReturnType<typeof saved>[number] & { usage?: unknown }>, conversationId = session) {
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

  it('a conversation that is gone keeps the question and says so, with no letters and no word of a cut', async () => {
    await ask('how many clusters?', new Response(sse({ error: 'Session not found', error_key: 'sessionNotFound' })))
    const html = panel()
    expect(rows(html)).toEqual(['how many clusters?', 'Session not found'])
    expect(answers(html)).toBe(0)
    expect(floatingChatStreamManager.getState().status).toBe('error')
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

  it('the same question asked again, its first copy on screen before the next was sent', async () => {
    await ask('why?', cut('Bec'))
    await ask('why?', stillComing('Now'), 1)
    expect(rows(panel(saved(['user', 'why?'])))).toEqual(['why?', 'Bec', CUT, 'why?', 'Now'])
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

  // The list a question was sent with can be behind: the answer before it was still on its way to the screen.
  describe('in its place when the saved messages reached the screen late', () => {
    const late = async () => {
      await ask('first?', answered('First.'), 0)
      await ask('failed?', refused(), 0)
    }

    it('with the next answer saved', async () => {
      await late()
      await ask('third?', answered('Third.'), 0)
      expect(rows(panel(saved(['user', 'first?'], ['assistant', 'First.'], ['user', 'third?'], ['assistant', 'Third.']))))
        .toEqual(['first?', 'First.', 'failed?', REFUSED, 'third?', 'Third.'])
    })

    it('with the next question not saved yet', async () => {
      await late()
      await ask('third?', stillComing('Now'), 0)
      expect(rows(panel(saved(['user', 'first?'], ['assistant', 'First.']))))
        .toEqual(['first?', 'First.', 'failed?', REFUSED, 'third?', 'Now'])
    })

    it('with its own question saved', async () => {
      await late()
      await ask('third?', answered('Third.'), 0)
      expect(rows(panel(saved(['user', 'first?'], ['assistant', 'First.'], ['user', 'failed?'], ['user', 'third?'], ['assistant', 'Third.']))))
        .toEqual(['first?', 'First.', 'failed?', REFUSED, 'third?', 'Third.'])
    })

    it('with two failures in a row', async () => {
      await late()
      await ask('again?', cut('Par'), 0)
      await ask('third?', answered('Third.'), 0)
      expect(rows(panel(saved(['user', 'first?'], ['assistant', 'First.'], ['user', 'third?'], ['assistant', 'Third.']))))
        .toEqual(['first?', 'First.', 'failed?', REFUSED, 'again?', 'Par', CUT, 'third?', 'Third.'])
    })
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

// The server saves what a failed turn wrote, marked, before it sends the error.
describe('the floating chat with a failed answer the server saved', () => {
  const FAILED = 'AI model call failed'
  const NOTE = 'The answer ended here because of an error. What came before it is kept.'
  const failing = (text: string) => new Response(sse({ content: text }, { error: FAILED }))
  const answerFailed = (...messages: [string, string][]) => saved(...messages).map((m) => (m.role === 'assistant' ? { ...m, usage: { failed: true } } : m))

  it('shows once, with the error under it', async () => {
    await ask('first?', failing('Par'))
    expect(rows(panel(answerFailed(['user', 'first?'], ['assistant', 'Par'])))).toEqual(['first?', 'Par', FAILED])
  })

  it('shows once when the next question comes, with the error in its place', async () => {
    await ask('first?', failing('Par'))
    await ask('second?', stillComing('Now'), 2)
    expect(rows(panel(answerFailed(['user', 'first?'], ['assistant', 'Par'])))).toEqual(['first?', 'Par', FAILED, 'second?', 'Now'])
  })

  it('shows once when the list had not reached the screen as the next question was sent', async () => {
    await ask('first?', failing('Par'))
    await ask('second?', stillComing('Now'), 0)
    expect(rows(panel())).toEqual(['first?', 'Par', FAILED, 'second?', 'Now'])
    expect(rows(panel(answerFailed(['user', 'first?'], ['assistant', 'Par'])))).toEqual(['first?', 'Par', FAILED, 'second?', 'Now'])
  })

  it('stands for its turn even when the letters differ, as an unfinished tool block does', async () => {
    await ask('first?', failing('Par '))
    await ask('second?', stillComing('Now'), 0)
    expect(rows(panel(answerFailed(['user', 'first?'], ['assistant', 'Par saved'])))).toEqual(['first?', 'Par saved', FAILED, 'second?', 'Now'])
  })

  it('does not stand for a turn whose letters the server never had', async () => {
    await ask('first?', cut('Cut'))
    await ask('second?', failing('Par'), 0)
    await ask('third?', stillComing('Now'), 0)
    expect(rows(panel(answerFailed(['user', 'first?'], ['user', 'second?'], ['assistant', 'Par']))))
      .toEqual(['first?', 'Cut', CUT, 'second?', 'Par', FAILED, 'third?', 'Now'])
  })

  it('says it ended by an error once the page was read again, with nothing else to say so', () => {
    const html = panel(answerFailed(['user', 'first?'], ['assistant', 'Par']))
    expect(rows(html)).toEqual(['first?', 'Par', NOTE])
    expect(answers(html)).toBe(1)
  })

  it('a finished answer says nothing of the kind', () => {
    expect(rows(panel(saved(['user', 'first?'], ['assistant', 'Done.'])))).toEqual(['first?', 'Done.'])
  })
})

// The server answered 404 for a conversation: the turn that found out stays on screen until the next question, which starts a new one.
describe('a conversation the server no longer has', () => {
  it('stays on screen while the turn that found out is the last thing it says', async () => {
    await ask('how many clusters?', new Response(sse({ error: 'Session not found', error_key: 'sessionNotFound' })))
    expect(forgetsConversation(floatingChatStreamManager.getState(), session)).toBe(false)
  })

  it('is forgotten when the tab only remembered it', () => {
    expect(forgetsConversation({ status: 'idle', sessionId: null }, session)).toBe(true)
    expect(forgetsConversation({ status: 'completed', sessionId: session }, session)).toBe(true)
    expect(forgetsConversation({ status: 'error', sessionId: 'another' }, session)).toBe(true)
  })

  it('takes these answers for gone', () => {
    const quiet = { errorKey: null, sessionId: session }
    expect(conversationGone({ response: { status: 404 } }, quiet, session)).toBe(true)
    expect(conversationGone({ response: { status: 403 } }, quiet, session)).toBe(true)
    expect(conversationGone({ response: { status: 500 } }, quiet, session)).toBe(false)
    expect(conversationGone(null, quiet, session)).toBe(false)
  })

  it('takes the chat saying so for gone, before the read of the list has answered', () => {
    expect(conversationGone(null, { errorKey: 'sessionNotFound', sessionId: session }, session)).toBe(true)
    expect(conversationGone(null, { errorKey: 'sessionNotFound', sessionId: 'another' }, session)).toBe(false)
    expect(conversationGone(null, { errorKey: 'streamCut', sessionId: session }, session)).toBe(false)
  })
})

// As AI Chat's (streamEnd.test.ts): session-service adds the stopped answer only while its question is the newest
// message, so one stopped as it ended, which ai-service saved already, is not saved twice.
describe('the floating chat saves a stopped answer as the answer to its question', () => {
  it('names that question in the save, beside the stopped marker', () => {
    const save = chatPanelSrc.slice(chatPanelSrc.indexOf('const handleStop = async'), chatPanelSrc.indexOf('// What the panel holds'))
    expect(save).toContain('/messages`')
    expect(save).toMatch(/stopped: true,\n(?:\s*\/\/.*\n)?\s*answers: stopped\.userMessage \?\? undefined,/)
  })
})

// handleStop saves a stopped answer's letters, and that request can fail or still be on its way when the next question
// is sent. The letters stay until the saved messages have them, as they do in AI Chat's bubbles.
describe('the floating chat keeps a stopped answer when the next question comes', () => {
  async function stopped(question: string, letters: string, savedBefore = 0) {
    await ask(question, stillComing(letters), savedBefore)
    await floatingChatStreamManager.stop()
    await vi.runAllTimersAsync()
  }

  it('above the next answer while it comes, its save having failed', async () => {
    await stopped('first?', 'Par')
    await ask('second?', stillComing('Now'), 1)
    const html = panel(saved(['user', 'first?']))
    expect(rows(html)).toEqual(['first?', 'Par', 'second?', 'Now'])
    expect(answers(html)).toBe(2)
  })

  it('with its question too, when the server had saved neither', async () => {
    await stopped('first?', 'Par')
    await ask('second?', stillComing('Now'))
    expect(rows(panel())).toEqual(['first?', 'Par', 'second?', 'Now'])
  })

  it('and once the next answer is saved', async () => {
    await stopped('first?', 'Par')
    await ask('second?', answered('Now'), 1)
    expect(rows(panel(saved(['user', 'first?'], ['user', 'second?'], ['assistant', 'Now'])))).toEqual(['first?', 'Par', 'second?', 'Now'])
  })

  it('and once the next answer is saved, when its question was not', async () => {
    await stopped('first?', 'Par')
    await ask('second?', answered('Now'))
    expect(rows(panel(saved(['user', 'second?'], ['assistant', 'Now'])))).toEqual(['first?', 'Par', 'second?', 'Now'])
  })

  it('with its tool block, and no error under it', async () => {
    await ask('first?', (_url: string, init: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse({ content: 'Checking.' }, { function: 'list_clusters', args: {}, call_id: 0 })))
        init.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')))
      },
    })))
    await floatingChatStreamManager.stop()
    await vi.runAllTimersAsync()
    await ask('second?', stillComing('Now'), 1)
    const html = panel(saved(['user', 'first?']))
    expect(html).toContain('🔧 <strong>list_clusters</strong>')
    expect(html.indexOf('Checking.')).toBeLessThan(html.indexOf('list_clusters'))
    expect(html.indexOf('list_clusters')).toBeLessThan(html.indexOf('second?'))
    expect(html).not.toContain('before the answer finished')
    expect(answers(html)).toBe(2)
  })

  it('once, when its save reached the screen before the next question', async () => {
    await stopped('first?', 'Par')
    await ask('second?', stillComing('Now'), 2)
    expect(rows(panel(saved(['user', 'first?'], ['assistant', 'Par'])))).toEqual(['first?', 'Par', 'second?', 'Now'])
  })

  it('once, when its save arrives after the next question was sent', async () => {
    await stopped('first?', 'Par')
    await ask('second?', stillComing('Now'), 1)
    expect(rows(panel(saved(['user', 'first?'])))).toEqual(['first?', 'Par', 'second?', 'Now'])
    expect(rows(panel(saved(['user', 'first?'], ['assistant', 'Par'])))).toEqual(['first?', 'Par', 'second?', 'Now'])
    expect(rows(panel(saved(['user', 'first?'], ['assistant', 'Par'], ['user', 'second?'])))).toEqual(['first?', 'Par', 'second?', 'Now'])
  })

  it('once, in the order saved, when its save arrives after the next question was saved', async () => {
    await stopped('first?', 'Par')
    await ask('second?', answered('Now'), 1)
    expect(rows(panel(saved(['user', 'first?'], ['user', 'second?'], ['assistant', 'Par'], ['assistant', 'Now']))))
      .toEqual(['first?', 'second?', 'Par', 'Now'])
  })

  it('an earlier answer with the same letters does not stand for it', async () => {
    await stopped('again?', 'Same', 2)
    await ask('next?', stillComing('Now'), 3)
    expect(rows(panel(saved(['user', 'first?'], ['assistant', 'Same'], ['user', 'again?'])))).toEqual(['first?', 'Same', 'again?', 'Same', 'next?', 'Now'])
  })

  it('keeps a question stopped before its first letter, which nothing else holds', async () => {
    await stopped('first?', '')
    await ask('second?', stillComing('Now'))
    const html = panel()
    expect(rows(html)).toEqual(['first?', 'second?', 'Now'])
    expect(answers(html)).toBe(1)
  })

  it('shows such a question once, when the server had saved it', async () => {
    await stopped('first?', '')
    await ask('second?', stillComing('Now'), 1)
    expect(rows(panel(saved(['user', 'first?'])))).toEqual(['first?', 'second?', 'Now'])
  })

  it('the same question asked again shows twice, each with its own answer', async () => {
    await stopped('why?', 'Bec')
    await ask('why?', stillComing('Now'), 1)
    expect(rows(panel(saved(['user', 'why?'])))).toEqual(['why?', 'Bec', 'why?', 'Now'])
    expect(rows(panel(saved(['user', 'why?'], ['user', 'why?'])))).toEqual(['why?', 'Bec', 'why?', 'Now'])
  })

  it('two stopped answers in a row stay in the order they came', async () => {
    await stopped('one?', 'Fir')
    await stopped('two?', 'Sec', 1)
    await ask('three?', stillComing('Now'), 2)
    expect(rows(panel(saved(['user', 'one?'], ['user', 'two?'])))).toEqual(['one?', 'Fir', 'two?', 'Sec', 'three?', 'Now'])
  })

  it('with a failed turn before it, in the order they came', async () => {
    await ask('one?', refused())
    await stopped('two?', 'Par')
    await ask('three?', stillComing('Now'), 1)
    expect(rows(panel(saved(['user', 'two?'])))).toEqual(['one?', REFUSED, 'two?', 'Par', 'three?', 'Now'])
  })

  it('another conversation shows none of it', async () => {
    const other = `${session}-other`
    await stopped('first?', 'Par')
    await ask('elsewhere?', stillComing('Here'), 0, other)
    expect(rows(panel(undefined, other))).toEqual(['elsewhere?', 'Here'])
  })

  it('a panel opened again shows the same', async () => {
    await stopped('first?', 'Par')
    await ask('second?', stillComing('Now'), 1)
    const history = saved(['user', 'first?'])
    expect(rows(panel(history))).toEqual(rows(panel(history)))
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
