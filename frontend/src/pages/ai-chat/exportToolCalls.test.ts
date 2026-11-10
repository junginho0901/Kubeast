import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { failureText } from '@/utils/failureText'
import { exportToolCallsAsZip } from './exportToolCalls'

// What the bubble is told after "Download result ZIP": a ZIP of whole results, one with some results cut when no
// whole copy could be read, or why no ZIP was made — never a press that ends with nothing on screen.

const api = vi.hoisted(() => ({ getSession: vi.fn() }))
vi.mock('@/services/api', () => ({ api }))

const zipped = vi.hoisted(() => ({ files: [] as string[], refuse: null as Error | null }))
vi.mock('jszip', () => ({
  default: class {
    file(name: string) {
      zipped.files.push(name)
    }
    generateAsync() {
      return zipped.refuse ? Promise.reject(zipped.refuse) : Promise.resolve(new Blob(['zip']))
    }
  },
}))

const CUT = 'first lines\n... (truncated) ...\nlast lines'
const call = (result: string) => ({ function: 'k8s_get_resources', args: { namespace: 'default' }, result })
const run = (toolCalls: unknown[], sessionId: string | null = 's1') =>
  exportToolCallsAsZip({ message: { id: 7, role: 'assistant', content: 'answer', toolCalls }, sessionId, t: (k) => k, getCurrentMessages: () => [] })

let clicked: string[]
beforeEach(() => {
  clicked = []
  zipped.files = []
  zipped.refuse = null
  api.getSession.mockReset()
  vi.stubGlobal('window', {})
  vi.stubGlobal('document', {
    createElement: () => ({ click(this: { download: string }) { clicked.push(this.download) } }),
    body: { appendChild() {}, removeChild() {} },
  })
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:zip')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.mocked(URL.createObjectURL).mockRestore()
  vi.mocked(URL.revokeObjectURL).mockRestore()
})

describe('exportToolCallsAsZip', () => {
  it('downloads whole results and says nothing more', async () => {
    api.getSession.mockResolvedValue({ messages: [{ id: 7, role: 'assistant', content: 'answer', tool_calls: [call('whole')] }] })
    expect(await run([call('whole')])).toEqual({ kind: 'done' })
    expect(clicked).toHaveLength(1)
    expect(zipped.files).toHaveLength(1)
  })

  it('takes the saved whole result in place of a cut one on screen', async () => {
    api.getSession.mockResolvedValue({ messages: [{ id: 7, role: 'assistant', content: 'answer', tool_calls: [call('whole')] }] })
    expect(await run([call(CUT)])).toEqual({ kind: 'done' })
  })

  it('says some results are cut when no whole copy could be read', async () => {
    api.getSession.mockRejectedValue(new Error('Network Error'))
    expect(await run([call(CUT)])).toEqual({ kind: 'cut' })
    expect(clicked, 'the ZIP still goes').toHaveLength(1)
    api.getSession.mockResolvedValue({ messages: [{ id: 7, role: 'assistant', content: 'answer', tool_calls: [call(CUT)] }] })
    expect(await run([call(CUT)])).toEqual({ kind: 'cut' })
  })

  it('says why no ZIP was made', async () => {
    api.getSession.mockResolvedValue({ messages: [] })
    zipped.refuse = new Error('out of memory')
    const outcome = await run([call('whole')])
    expect(outcome.kind).toBe('failed')
    expect(outcome.kind === 'failed' && failureText(outcome.error)).toBe('out of memory')
    expect(clicked, 'nothing was downloaded').toHaveLength(0)
  })

  it('has nothing to do for an answer without tool calls', async () => {
    expect(await run([])).toEqual({ kind: 'nothing' })
    expect(api.getSession).not.toHaveBeenCalled()
  })
})
