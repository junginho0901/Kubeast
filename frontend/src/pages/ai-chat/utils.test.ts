import { describe, expect, it } from 'vitest'

import { sessionListFailure } from './utils'

describe("the conversation list's failure line", () => {
  const del = new Error('delete refused')
  const ren = new Error('rename refused')

  it('is nothing while nothing was refused', () => {
    expect(sessionListFailure(null, 0, null, 0)).toBeNull()
  })

  it('is the one refused, delete or rename', () => {
    expect(sessionListFailure(del, 10, null, 0)).toEqual({ error: del, action: 'delete' })
    expect(sessionListFailure(null, 0, ren, 10)).toEqual({ error: ren, action: 'change' })
  })

  it('is the one sent last when both were refused', () => {
    expect(sessionListFailure(del, 10, ren, 20)).toEqual({ error: ren, action: 'change' })
    expect(sessionListFailure(del, 30, ren, 20)).toEqual({ error: del, action: 'delete' })
  })
})
