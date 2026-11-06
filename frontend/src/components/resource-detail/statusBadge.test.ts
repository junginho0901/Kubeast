import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { StatusBadge } from './DetailCommon'

// The CronJob drawer's Jobs table draws a Job's status with this badge: each word kubectl's printJob prints in the colour
// of what it means, none in the blue of a value that says nothing.
describe('StatusBadge draws a Job status by what it means', () => {
  const colours: Record<string, string> = {
    Complete: 'badge-success',
    SuccessCriteriaMet: 'badge-success',
    Running: 'badge-success',
    Suspended: 'badge-warning',
    Terminating: 'badge-warning',
    Failed: 'badge-error',
    FailureTarget: 'badge-error',
  }
  for (const [status, colour] of Object.entries(colours)) {
    it(`${status} is ${colour}`, () => {
      const html = renderToStaticMarkup(createElement(StatusBadge, { status }))
      expect(/badge-\w+/.exec(html)?.[0]).toBe(colour)
      expect(html).toContain(`>${status}<`)
    })
  }
})
