import { afterEach, describe, expect, it, vi } from 'vitest'
import { ADMIN_USERS_PAGE, adminApi, readAllUsers } from './admin'
import type { Member } from './types'

const people = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `u${String(from + i).padStart(4, '0')}`, name: `user ${from + i}` }) as Member)

// GET /auth/admin/users: newest first, at most `cap` a page, no total
const server = (users: Member[], cap = 200) => {
  const asked: number[] = []
  const page = async (offset: number, limit = ADMIN_USERS_PAGE) => {
    asked.push(offset)
    return users.slice(offset, offset + Math.min(limit, cap))
  }
  return { asked, page }
}

describe('reading every user', () => {
  it.each([200, 201, 401])('reads all %i users, page by page, until a page comes back empty', async (n) => {
    const users = people(n)
    const s = server(users)
    const got = await readAllUsers((offset) => s.page(offset))
    expect(got.map((u) => u.id)).toEqual(users.map((u) => u.id))
    const pages = Math.ceil(n / ADMIN_USERS_PAGE)
    expect(s.asked).toEqual([...Array.from({ length: pages }, (_, i) => i * ADMIN_USERS_PAGE), n])
  })

  it('does not take a short page for the end when the server pages smaller than asked', async () => {
    const users = people(201)
    const s = server(users, 50)
    expect((await readAllUsers((offset) => s.page(offset))).length).toBe(201)
    expect(s.asked).toEqual([0, 50, 100, 150, 200, 201])
  })

  it('keeps a user once when one made while reading moves the list down', async () => {
    const users = people(250, 1)
    let first = true
    const got = await readAllUsers(async (offset) => {
      const page = users.slice(offset, offset + ADMIN_USERS_PAGE)
      if (first) {
        first = false
        users.unshift(...people(1, 0)) // the newest goes first
      }
      return page
    })
    expect(got.length).toBe(250)
    expect(new Set(got.map((u) => u.id)).size).toBe(250)
    expect(got.map((u) => u.id)).toEqual(people(250, 1).map((u) => u.id))
  })

  it('stops with an error when the offset is not applied, instead of a short list', async () => {
    const users = people(300)
    await expect(readAllUsers(async () => users.slice(0, ADMIN_USERS_PAGE))).rejects.toThrow(/did not move past offset 200/)
  })
})

describe('adminListAllUsers', () => {
  afterEach(() => vi.restoreAllMocks())

  it('asks the users API for pages of the largest size until it has them all', async () => {
    const users = people(401)
    const spy = vi.spyOn(adminApi, 'adminListUsers').mockImplementation(async (params) =>
      users.slice(params?.offset ?? 0, (params?.offset ?? 0) + Math.min(params?.limit ?? 100, 200)))
    const got = await adminApi.adminListAllUsers()
    expect(got.length).toBe(401)
    expect(spy.mock.calls.map((c) => c[0])).toEqual([
      { limit: 200, offset: 0 }, { limit: 200, offset: 200 }, { limit: 200, offset: 400 }, { limit: 200, offset: 401 },
    ])
  })
})
