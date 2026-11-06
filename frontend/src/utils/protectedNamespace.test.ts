import { describe, expect, it } from 'vitest'
import { isProtectedNamespaceError } from './protectedNamespace'

describe('isProtectedNamespaceError', () => {
  it('reads the reason the server gives with a refusal of the namespace', () => {
    expect(isProtectedNamespaceError({ response: { status: 403, data: { detail: 'forbidden: namespace', reason: 'protected_namespace' } } })).toBe(true)
  })

  it('a refusal for any other reason, or no refusal, is something else', () => {
    expect(isProtectedNamespaceError({ response: { status: 403, data: { detail: 'forbidden' } } })).toBe(false)
    expect(isProtectedNamespaceError(new Error('Network Error'))).toBe(false)
    expect(isProtectedNamespaceError(null)).toBe(false)
  })
})
