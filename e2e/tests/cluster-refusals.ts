// What refusals.teardown.ts reads. k8s-service sends a cluster request only as the signed-in person (or as Kubeast for
// its own version, discovery and health reads) and refuses one whose context names no person; tool-server does the same
// for a kubectl run. A read that drops its error (the server version, the API groups) shows only a blank when it is
// refused, so a run counts the lines below in those servers' logs instead.

// The cluster transport's slog message (services/pkg/auth, ErrNoPerson) and services/tool-server/kubectl.go (errNoPerson)
export const REFUSAL_LINES = ['cluster request with no person refused', 'kubectl not run'] as const

// The chart's app labels of the servers that write them (k8s-service-stream only when streams.enabled). tool-server
// answers its refusal as the call's error without a log line; ai-service logs that error ("Error in <tool>: …",
// app/services/ai/tool_dispatch.py).
export const SERVERS = ['k8s-service', 'k8s-service-stream', 'tool-server', 'ai-service'] as const

export type ContainerLog = { source: string; text: string }

type ContainerStatus = {
  name: string
  restartCount?: number
  state?: { waiting?: object }
  lastState?: { terminated?: { finishedAt?: string } }
}
type Pod = { metadata: { name: string }; status?: { containerStatuses?: ContainerStatus[] } }

// Every line of the logs that holds one of REFUSAL_LINES, after the pod and container it came from
export function refusals(logs: ContainerLog[]): string[] {
  return logs.flatMap(({ source, text }) =>
    text.split('\n').filter((line) => REFUSAL_LINES.some((r) => line.includes(r))).map((line) => `${source}: ${line}`))
}

// The log since `since` (RFC 3339) of every container of every pod of SERVERS, and of the container's run before its
// last restart when that run ended after `since`. A pod removed during the run (a rollout) is not read.
export function serverLogs(kubectl: (args: string[]) => string, ns: string, since: string): ContainerLog[] {
  const selector = `app in (${SERVERS.join(',')})`
  const pods = (JSON.parse(kubectl(['-n', ns, 'get', 'pods', '-l', selector, '-o', 'json'])) as { items: Pod[] }).items
  const sinceMs = Date.parse(since)
  return pods.flatMap((pod) => (pod.status?.containerStatuses ?? []).flatMap((c) => {
    const args = ['-n', ns, 'logs', pod.metadata.name, '-c', c.name, '--tail=-1', `--since-time=${since}`]
    const source = `${pod.metadata.name}/${c.name}`
    const logs: ContainerLog[] = c.state?.waiting ? [] : [{ source, text: kubectl(args) }]
    const ended = c.lastState?.terminated?.finishedAt
    if ((c.restartCount ?? 0) > 0 && (!ended || Date.parse(ended) >= sinceMs)) {
      logs.push({ source: `${source} (previous)`, text: kubectl([...args, '--previous']) })
    }
    return logs
  }))
}
