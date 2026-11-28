import fs from 'node:fs'
import path from 'node:path'

// The GET routes of k8s-service (scripts/api-snapshot.sh's list), auth-service, session-service and ai-service as the gateway serves them.
const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const goGets = (text: string) => [...text.matchAll(/\.Get\("(\/[^"]*)"/g)].map((m) => m[1])
const pyGets = (text: string) => [...text.matchAll(/@\w+\.get\("([^"]*)"/g)].map((m) => m[1])

const AI_ROUTERS: [string, string][] = [
  ['app/api.py', '/api/v1/ai'],
  ['app/api_public.py', '/api/v1/ai'],
  ['app/api_model_uses.py', '/api/v1/ai/model-configs'],
  ['app/api_investigations.py', '/api/v1/ai/investigations'],
  ['app/api_alert_inbox.py', '/api/v1/alerts'],
]

export const LEFT_OUT: { route: RegExp; why: string }[] = [
  { route: /^\/api\/v1\/auth\/oidc\/login$/, why: 'starts a sign-in: sets the state cookie and sends the browser to the provider (GET by the OIDC protocol)' },
  { route: /^\/api\/v1\/auth\/oidc\/callback$/, why: 'ends a sign-in: sets the session cookie and can make or link the account (GET by the OIDC protocol)' },
  { route: /^\/api\/v1\/ai\/suggest-optimization\/stream$/, why: 'an event stream that asks the AI model (EventSource sends GET only)' },
  { route: /\/stream$/, why: 'an event stream held open until the client leaves (EventSource sends GET only)' },
  { route: /\/ws$|\/wsMultiplexer$|\/exec(\/|$)|\/watch(\/|$)/, why: 'a WebSocket handshake (exec, node shell, watch): the socket carries the work, and the handshake checks Origin' },
  { route: /^\/api\/v1\/auth\/admin\/oidc\/groups$/, why: 'asks the Google Workspace directory, a service outside the install' },
  { route: /\{/, why: 'needs an object id or name in the path, as scripts/api-snapshot.sh leaves out' },
]

export type GetRoutes = { called: string[]; leftOut: { route: string; why: string }[] }

export function getRoutes(namespace: string, cluster = 'self'): GetRoutes {
  const k8sDir = 'services/k8s-service-go/internal/routes'
  const k8s = [
    ...fs.readdirSync(path.join(ROOT, k8sDir)).filter((f) => f.endsWith('.go') && !f.endsWith('_test.go')).flatMap((f) => goGets(read(`${k8sDir}/${f}`))),
    ...goGets(read('services/k8s-service-go/cmd/server/main.go')),
  ].filter((p) => p.startsWith('/api/v1/')).map((p) => p.replace('/api/v1/', '/api/v1/cluster/'))
  const auth = goGets(read('services/auth-service-go/cmd/server/routes.go'))
    .filter((p) => !p.startsWith('/internal/'))
    .map((p) => (p.startsWith('/api/v1/') ? p : `/api/v1/auth${p}`))
  const sessions = goGets(read('services/session-service-go/cmd/server/main.go')).filter((p) => p.startsWith('/sessions')).map((p) => `/api/v1${p}`)
  const ai = AI_ROUTERS.flatMap(([file, prefix]) => pyGets(read(`services/ai-service/${file}`)).map((p) => `${prefix}${p}`))
  const called: string[] = []
  const leftOut: { route: string; why: string }[] = []
  for (const route of [...new Set([...k8s, ...auth, ...sessions, ...ai])].sort()) {
    const filled = route.split('{namespace}').join(namespace)
    const rule = LEFT_OUT.find((r) => r.route.test(filled))
    if (rule) leftOut.push({ route, why: rule.why })
    else called.push(`${filled}?cluster=${encodeURIComponent(cluster)}`)
  }
  return { called, leftOut }
}
