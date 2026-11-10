import { describe, expect, it } from 'vitest'
import { ROLE_MENU_ROOM, roleMenuOpensUp } from './roleMenu'

// The Users table scrolls inside its card, which cuts off what passes its bottom edge.
describe('the role menu of a Users row', () => {
  it('opens upward on a row near the bottom of the table, where a menu below would be cut off', () => {
    // the last row of a full page: its button ends 30 px above the table's bottom
    expect(roleMenuOpensUp(700, 670)).toBe(true)
    expect(roleMenuOpensUp(700, 700 - ROLE_MENU_ROOM + 1)).toBe(true)
  })

  it('opens below on a row with room under it', () => {
    expect(roleMenuOpensUp(700, 200)).toBe(false)
    expect(roleMenuOpensUp(700, 700 - ROLE_MENU_ROOM)).toBe(false)
  })
})
