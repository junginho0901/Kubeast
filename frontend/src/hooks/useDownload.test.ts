import { describe, expect, it } from 'vitest'

import { fileNameOf } from './useDownload'

describe('fileNameOf', () => {
  it('reads the names the servers write', () => {
    // auth-service writes Go's %q, k8s-service a quoted name
    expect(fileNameOf('attachment; filename="audit-logs-20261110-204500.csv"')).toBe('audit-logs-20261110-204500.csv')
    expect(fileNameOf('attachment; filename="access-review-admins-2026.csv"')).toBe('access-review-admins-2026.csv')
    expect(fileNameOf('attachment; filename="a\\"b.csv"')).toBe('a"b.csv')
    expect(fileNameOf('attachment; filename=plain.json')).toBe('plain.json')
  })

  it('prefers filename* (UTF-8) and keeps the plain one when it does not decode', () => {
    expect(fileNameOf("attachment; filename=\"fallback.txt\"; filename*=UTF-8''%ED%95%9C%EA%B8%80.txt")).toBe('한글.txt')
    expect(fileNameOf("attachment; filename=\"fallback.txt\"; filename*=UTF-8''%E0%A4%A.txt")).toBe('fallback.txt')
  })

  it('has no name without the header or a filename in it', () => {
    expect(fileNameOf(null)).toBeNull()
    expect(fileNameOf('attachment')).toBeNull()
  })
})
