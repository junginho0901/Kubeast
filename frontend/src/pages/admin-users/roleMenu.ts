// The role menu of a Users row opens below its button, or above it when the table's scroll box (which cuts off
// what passes its edge) has no room for it below.

// About the height of the menu: three roles of 32 px and its border, with the gap above it.
export const ROLE_MENU_ROOM = 120

export function roleMenuOpensUp(tableBottom: number, buttonBottom: number): boolean {
  return tableBottom - buttonBottom < ROLE_MENU_ROOM
}
