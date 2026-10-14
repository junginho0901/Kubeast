import { describe, expect, it } from 'vitest'
import { aiEnabled, alertInvestigationEnabled, costEnabled, logSearchEnabledFor, policyReportsEnabled } from './features'

describe('aiEnabled', () => {
  it('is off only when the server says so', () => {
    expect(aiEnabled({ prometheus: { enabled: false }, ai: { enabled: false } })).toBe(false)
    expect(aiEnabled({ prometheus: { enabled: false }, ai: { enabled: true } })).toBe(true)
    expect(aiEnabled({ prometheus: { enabled: false } })).toBe(true)
    expect(aiEnabled(undefined)).toBe(true)
  })
})

describe('costEnabled', () => {
  it('is on only when the server says so (an older server has no cost API)', () => {
    expect(costEnabled({ prometheus: { enabled: false }, cost: { enabled: true } })).toBe(true)
    expect(costEnabled({ prometheus: { enabled: false }, cost: { enabled: false } })).toBe(false)
    expect(costEnabled({ prometheus: { enabled: false } })).toBe(false)
    expect(costEnabled(undefined)).toBe(false)
  })
})

describe('policyReportsEnabled', () => {
  it('is on only when the server says so', () => {
    expect(policyReportsEnabled({ prometheus: { enabled: false }, policyReports: { enabled: true } })).toBe(true)
    expect(policyReportsEnabled({ prometheus: { enabled: false }, policyReports: { enabled: false } })).toBe(false)
    expect(policyReportsEnabled({ prometheus: { enabled: false } })).toBe(false)
    expect(policyReportsEnabled(undefined)).toBe(false)
  })
})

describe('alertInvestigationEnabled', () => {
  it('is on only when the server says so', () => {
    expect(alertInvestigationEnabled({ prometheus: { enabled: false }, alertInvestigation: { enabled: true } })).toBe(true)
    expect(alertInvestigationEnabled({ prometheus: { enabled: false }, alertInvestigation: { enabled: false } })).toBe(false)
    expect(alertInvestigationEnabled({ prometheus: { enabled: false } })).toBe(false)
    expect(alertInvestigationEnabled(undefined)).toBe(false)
  })
})

describe('logSearchEnabledFor', () => {
  it('is on only for a cluster the log store is configured for', () => {
    const on = { prometheus: { enabled: false }, logSearch: { enabled: true, clusters: ['self', 'alpha'] } }
    expect(logSearchEnabledFor(on, 'alpha')).toBe(true)
    expect(logSearchEnabledFor(on, 'prod')).toBe(false)
    expect(logSearchEnabledFor(on, '')).toBe(false)
    expect(logSearchEnabledFor({ prometheus: { enabled: false }, logSearch: { enabled: false, clusters: ['self'] } }, 'self')).toBe(false)
    expect(logSearchEnabledFor({ prometheus: { enabled: false } }, 'self')).toBe(false)
    expect(logSearchEnabledFor(undefined, 'self')).toBe(false)
  })
})

