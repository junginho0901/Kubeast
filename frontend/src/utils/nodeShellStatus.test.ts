import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import { nodeShellStatusLines, parseNodeShellStatus } from './nodeShellStatus'

// A t() that fills the fallback the way i18next does without a catalog.
const t = ((_key: string, opts: Record<string, unknown>) =>
  String(opts.defaultValue).replace(/\{\{(\w+)\}\}/g, (_m, k) => String(opts[k] ?? ''))) as unknown as TFunction

describe('parseNodeShellStatus', () => {
  it('reads a status frame', () => {
    expect(parseNodeShellStatus('{"type":"status","status":"waiting","reason":"ImagePullBackOff"}')).toEqual({
      type: 'status',
      status: 'waiting',
      reason: 'ImagePullBackOff',
    })
  })

  it('leaves other text alone', () => {
    expect(parseNodeShellStatus('failed to connect to K8s API: boom')).toBeNull()
    expect(parseNodeShellStatus('{not json')).toBeNull()
    expect(parseNodeShellStatus('{"type":"other","status":"x"}')).toBeNull()
  })
})

describe('nodeShellStatusLines', () => {
  it('names the reason the pod is waiting for', () => {
    expect(nodeShellStatusLines({ type: 'status', status: 'waiting' }, t)).toEqual(['Waiting for the debug Pod to start...'])
    expect(
      nodeShellStatusLines({ type: 'status', status: 'waiting', reason: 'ImagePullBackOff', message: 'Back-off pulling image' }, t),
    ).toEqual(['Waiting: ImagePullBackOff — Back-off pulling image'])
  })

  it('says how long it waited and the last state on timeout', () => {
    expect(nodeShellStatusLines({ type: 'status', status: 'timeout', seconds: 90, reason: 'ErrImagePull' }, t)).toEqual([
      'The debug Pod did not start within 90 s.',
      'Last state: ErrImagePull',
    ])
  })

  it('covers the failure statuses', () => {
    expect(nodeShellStatusLines({ type: 'status', status: 'image-rejected', message: 'not on the list' }, t)[0]).toContain('not on the list')
    expect(nodeShellStatusLines({ type: 'status', status: 'audit-unavailable' }, t)[0]).toContain('audit log')
    expect(nodeShellStatusLines({ type: 'status', status: 'exited', reason: 'Error' }, t)[0]).toContain('Error')
  })

  it('shows an unknown status raw', () => {
    expect(nodeShellStatusLines({ type: 'status', status: 'new-thing', reason: 'R' }, t)).toEqual(['new-thing: R'])
  })
})
