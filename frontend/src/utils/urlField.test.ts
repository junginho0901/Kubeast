import { describe, expect, it } from 'vitest'

import { urlProblem } from './urlField'

describe('urlProblem: what the server would refuse, said in the field', () => {
  it('an empty field has nothing wrong', () => {
    expect(urlProblem('')).toBeNull()
    expect(urlProblem('   ')).toBeNull()
  })

  it('takes an http or https URL with a host, a single-label one too', () => {
    for (const ok of ['https://metrics.example.com/prometheus', 'http://10.0.0.5:9090', 'http://prometheus:9090', 'https://[::1]:8443/v1']) {
      expect(urlProblem(ok), ok).toBeNull()
    }
  })

  it('refuses what is not an http or https URL', () => {
    for (const bad of ['metrics.example.com', 'ftp://example.com', 'https://', 'http://:9090', 'not a url', 'localhost:9090', 'https://not%20a%20host']) {
      expect(urlProblem(bad), bad).toBe('notHttp')
    }
  })

  it('refuses a user or password in the address', () => {
    expect(urlProblem('https://bob:secret@example.com')).toBe('credentials')
    expect(urlProblem('https://bob@example.com')).toBe('credentials')
  })

  it('refuses a query or fragment only where the server does', () => {
    expect(urlProblem('https://example.com/p?x=1', { noQuery: true })).toBe('query')
    expect(urlProblem('https://example.com/p#x', { noQuery: true })).toBe('query')
    expect(urlProblem('https://example.com/p?x=1')).toBeNull()
  })

  it('hostPort takes host:port with no scheme, as a kubeconfig server, and still refuses the rest', () => {
    expect(urlProblem('10.0.0.1:6443', { hostPort: true })).toBeNull()
    expect(urlProblem('api.example.test', { hostPort: true })).toBeNull()
    expect(urlProblem('bob:secret@10.0.0.1:6443', { hostPort: true })).toBe('credentials')
    expect(urlProblem('//bob:secret@10.0.0.1:6443', { hostPort: true })).toBe('credentials')
    expect(urlProblem('not an address', { hostPort: true })).toBe('notHttp')
    expect(urlProblem('ftp://10.0.0.1:6443', { hostPort: true })).toBe('notHttp')
  })
})
