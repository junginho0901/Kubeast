import { test, expect } from '@playwright/test'

// H3: the node shell runs only allow-listed images, in the dedicated
// privileged namespace, never in the namespace/image the client asks for.
// The WebSocket is opened from the app origin so the HttpOnly login cookie
// authenticates it (no token in the URL).

async function firstNodeName(request: any): Promise<string> {
  const res = await request.get('/api/v1/cluster/nodes')
  expect(res.ok(), 'list nodes').toBeTruthy()
  const body = await res.json()
  const list: any[] = Array.isArray(body) ? body : body.items || body.nodes || []
  expect(list.length, 'at least one node').toBeGreaterThan(0)
  return typeof list[0] === 'string' ? list[0] : list[0].name || list[0].metadata?.name
}

// Opens the shell socket and resolves with the first text frame (or the close
// code when the server hangs up first).
async function openShell(page: any, node: string, image?: string): Promise<{ msg: string; closed: boolean }> {
  return page.evaluate(
    ({ node, image }: { node: string; image?: string }) =>
      new Promise<{ msg: string; closed: boolean }>((resolve) => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
        const q = new URLSearchParams({ namespace: 'default', ...(image ? { image } : {}) })
        const ws = new WebSocket(`${proto}//${location.host}/api/v1/cluster/nodes/${node}/debug-shell/ws?${q}`)
        ws.binaryType = 'arraybuffer'
        const done = (msg: string, closed: boolean) => {
          try { ws.close() } catch { /* ignore */ }
          resolve({ msg, closed })
        }
        ws.onmessage = (ev) => {
          const text = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer)
          done(text, false)
        }
        ws.onclose = () => done('', true)
        ws.onerror = () => done('', true)
        setTimeout(() => done('(timeout)', false), 60_000)
      }),
    { node, image },
  )
}

test.describe('node shell hardening (H3)', () => {
  test('rejects an image that is not on the allow list', async ({ page, request }) => {
    const node = await firstNodeName(request)
    await page.goto('/')
    const { msg } = await openShell(page, node, 'evil.example/rootkit:latest')
    expect(msg).toContain('not on the node shell allow list')
  })

  test('runs the allowed image in the dedicated privileged namespace', async ({ page, request }) => {
    const node = await firstNodeName(request)
    await page.goto('/')
    const { msg, closed } = await openShell(page, node)
    expect(closed, 'socket must not close before the shell starts').toBeFalsy()
    expect(msg).not.toContain('not on the node shell allow list')
    expect(msg).not.toContain('failed to create debug pod')

    // The debugger pod lives in kubeast-node-shell (never in the "default" we asked for).
    const pods = await request.get('/api/v1/cluster/namespaces/kubeast-node-shell/pods')
    expect(pods.ok(), 'list pods in kubeast-node-shell').toBeTruthy()
    const body = await pods.json()
    const items: any[] = Array.isArray(body) ? body : body.items || body.pods || []
    const names = items.map((p) => (typeof p === 'string' ? p : p.name || p.metadata?.name || ''))
    expect(names.some((n) => n.startsWith('node-debugger-')), `debugger pod in kubeast-node-shell: ${names}`).toBeTruthy()

    const inDefault = await request.get('/api/v1/cluster/namespaces/default/pods')
    const dBody = await inDefault.json()
    const dItems: any[] = Array.isArray(dBody) ? dBody : dBody.items || dBody.pods || []
    const dNames = dItems.map((p) => (typeof p === 'string' ? p : p.name || p.metadata?.name || ''))
    expect(dNames.some((n) => n.startsWith('node-debugger-')), 'no debugger pod in default').toBeFalsy()
  })
})
