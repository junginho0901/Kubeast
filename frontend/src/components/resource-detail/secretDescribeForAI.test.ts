import { describe, expect, it } from 'vitest'

import { secretDescribeForAI } from './secretDescribeForAI'

// Made up for the test.
const VALUE = 'fake-last-applied-value'
const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration'

describe('secretDescribeForAI', () => {
  const answer = {
    name: 'db',
    namespace: 'shop',
    type: 'Opaque',
    data_keys: ['conf'],
    data_sizes: { conf: 8 },
    data_values: { conf: 'ZmFrZQ==' },
    labels: { app: 'web' },
    annotations: { [LAST_APPLIED]: `{"stringData":{"conf":"{ ${VALUE} }"}}`, team: 'shop' },
  }

  it('sends no value: neither the data nor the copy an annotation keeps', () => {
    const text = JSON.stringify(secretDescribeForAI(answer))
    expect(text).not.toContain(VALUE)
    expect(text).not.toContain('ZmFrZQ==')
  })

  it('sends what the drawer shows about it: key names, sizes, labels and the annotations by name', () => {
    expect(secretDescribeForAI(answer)).toEqual({
      name: 'db',
      namespace: 'shop',
      type: 'Opaque',
      data_keys: ['conf'],
      data_sizes: { conf: 8 },
      labels: { app: 'web' },
      annotations: [LAST_APPLIED, 'team'],
    })
  })

  it('has nothing to send before the answer comes', () => {
    expect(secretDescribeForAI(undefined)).toBeUndefined()
  })

  it('leaves out annotations an object does not have', () => {
    expect(secretDescribeForAI({ name: 'db' })).toEqual({ name: 'db' })
  })
})
