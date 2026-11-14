import { describe, expect, it } from 'vitest'
import { aiEnabled, aiState, alertInvestigationEnabled, alertStoreEnabledFor, costEnabled, logSearchEnabledFor, policyReportsEnabled, traceTemplates } from './features'

describe('aiEnabled', () => {
  it('is off only when the server says so', () => {
    expect(aiEnabled({ prometheus: { enabled: false }, ai: { enabled: false } })).toBe(false)
    expect(aiEnabled({ prometheus: { enabled: false }, ai: { enabled: true } })).toBe(true)
    expect(aiEnabled({ prometheus: { enabled: false } })).toBe(true)
    expect(aiEnabled(undefined)).toBe(true)
  })
})

describe('aiState (AIGate, the MCP card)', () => {
  it('waits while the features are still their placeholder, which says nothing of AI', () => {
    expect(aiState({ prometheus: { enabled: true } }, true)).toBe('wait')
  })
  it('is off only when the answered features say so', () => {
    expect(aiState({ prometheus: { enabled: true }, ai: { enabled: false } }, false)).toBe('off')
    expect(aiState({ prometheus: { enabled: true }, ai: { enabled: true } }, false)).toBe('on')
  })
  it('counts unknown as on: an older server, a features read that failed, a cluster list that failed (no features will come)', () => {
    expect(aiState({ prometheus: { enabled: true } }, false)).toBe('on')
    expect(aiState(undefined, false)).toBe('on')
    expect(aiState({ prometheus: { enabled: true } }, true, true)).toBe('on')
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

describe('alertStoreEnabledFor', () => {
  it('is on only for a cluster the alert store holds, whatever alert investigation says', () => {
    const on = { prometheus: { enabled: false }, alertInvestigation: { enabled: false }, alertStore: { enabled: true, clusters: ['default'], silences: true } }
    expect(alertStoreEnabledFor(on, 'default')).toBe(true)
    expect(alertStoreEnabledFor(on, 'self')).toBe(false)
    expect(alertStoreEnabledFor(on, '')).toBe(false)
    expect(alertStoreEnabledFor({ prometheus: { enabled: false }, alertStore: { enabled: false, clusters: ['default'] } }, 'default')).toBe(false)
    expect(alertStoreEnabledFor(undefined, 'default')).toBe(false)
  })
})

describe('traceTemplates', () => {
  it('gives the templates only when tracing is on', () => {
    expect(traceTemplates(undefined)).toBeUndefined()
    expect(traceTemplates({ prometheus: { enabled: false }, tracing: { enabled: false, traceUrl: 'https://x/{{traceId}}' } })).toBeUndefined()
    expect(traceTemplates({ prometheus: { enabled: false }, tracing: { enabled: true, traceUrl: 'https://x/{{traceId}}', searchUrl: '' } })).toEqual({ traceUrl: 'https://x/{{traceId}}', searchUrl: undefined })
  })
})
