import { afterEach, describe, expect, it, vi } from 'vitest'
import { aiApi } from './ai'

describe('the Optimization stream', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads past the keepalive comments the server sends while the model is quiet', async () => {
    const body = [
      'data: {"kind":"observed","content":"| table |"}\n\n',
      ': keepalive\n\n',
      ': keepalive\n\n',
      'data: {"kind":"answer","content":"Lower the requests."}\n\n',
      ': keepalive\n\n',
      'data: [DONE]\n\n',
    ].join('')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
    const seen: string[] = []
    await aiApi.suggestOptimizationStream('apps', {
      onObserved: (c) => seen.push(`observed:${c}`),
      onContent: (c) => seen.push(`answer:${c}`),
      onError: (e) => seen.push(`error:${e}`),
      onDone: () => seen.push('done'),
    })
    expect(seen).toEqual(['observed:| table |', 'answer:Lower the requests.', 'done'])
  })
})
