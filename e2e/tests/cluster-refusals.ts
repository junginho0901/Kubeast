// What refusals.teardown.ts reads. k8s-service sends a cluster request only as the signed-in person (or as Kubeast for
// its own version, discovery and health reads) and refuses one whose context names no person; tool-server does the same
// for a kubectl run. A read that drops its error (the server version, the API groups) shows only a blank when it is
// refused, so a run counts the lines below in those servers' logs instead.

// The cluster transport's slog message (services/pkg/auth, ErrNoPerson) and services/tool-server/kubectl.go (errNoPerson)
export const REFUSAL_LINES = ['cluster request with no person refused', 'kubectl not run'] as const

// The chart's app labels of the servers that write them (k8s-service-stream only when streams.enabled). tool-server
// logs its refusal whichever call made the run (chat, MCP, alert investigation) and answers it as the call's error,
// which ai-service logs for a chat too ("Error in <tool>: …", app/services/ai/tool_dispatch.py).
export const SERVERS = ['k8s-service', 'k8s-service-stream', 'tool-server', 'ai-service'] as const

// unreadable: kubectl's first line when a container's run before could not be read; its lines were not counted
export type ContainerLog = { source: string; text: string; unreadable?: string }

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
// last restart when that run ended after `since`. A pod removed during the run (a rollout) is not read, and the pod that
// replaced it only from its start.
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
      try {
        logs.push({ source: `${source} (previous)`, text: kubectl([...args, '--previous']) })
      } catch (e) {
        // the kubelet keeps no run before (removed, or after a node restart)
        const why = String((e as { stderr?: string }).stderr || (e as Error).message).trim().split('\n')[0]
        logs.push({ source: `${source} (previous)`, text: '', unreadable: why })
      }
    }
    return logs
  }))
}
