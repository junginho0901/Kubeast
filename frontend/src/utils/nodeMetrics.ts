// PromQL for node values. node-exporter's `instance` is the node name in some installs and `<node IP>:9100` in
// the prometheus and kube-prometheus-stack charts, so its selector takes either, matched whole. A store without
// node-exporter can have the OpenTelemetry Collector's hostmetrics receiver instead (system_* names, the node in
// k8s_node_name): every query is "node-exporter or hostmetrics", both reduced to one series, so whichever the
// store has answers and node-exporter wins when it has both.

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const promString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

// instance=~"(?:<name>|<ip>…)(?::[0-9]+)?" — Prometheus anchors the regular expression, so node-1 does not match
// node-10. An IPv6 address appears in brackets.
export function nodeInstanceSelector(name: string, addresses: string[] = []): string {
  const hosts = [name, ...addresses]
    .filter((h, i, all) => h && all.indexOf(h) === i)
    .map((h) => (h.includes(':') ? `\\[${escapeRegex(h)}\\]` : escapeRegex(h)))
  return `instance=~${promString(`(?:${hosts.join('|')})(?::[0-9]+)?`)}`
}

export function nodeNameSelector(name: string): string {
  return `k8s_node_name=${promString(name)}`
}

// node-exporter's default diskstats exclusion (partitions, loop, ram), so hostmetrics adds up the same devices.
const DISK_EXCLUDE = promString('(z?ram|loop|fd|(h|s|v|xv)d[a-z]|nvme\\d+n\\d+p)\\d+')

type Queries = Record<'cpu' | 'memory' | 'disk_read' | 'disk_write' | 'network_rx' | 'network_tx' | 'load1' | 'filesystem', string>

// {a,b,…} from the matchers that are set (the cluster-wide queries have no node selector).
const m = (...matchers: string[]) => {
  const set = matchers.filter(Boolean)
  return set.length ? `{${set.join(',')}}` : ''
}

function nodeExporter(sel: string): Queries {
  return {
    cpu: `100 - (avg(rate(node_cpu_seconds_total${m('mode="idle"', sel)}[5m])) * 100)`,
    memory: `(1 - sum(node_memory_MemAvailable_bytes${m(sel)}) / sum(node_memory_MemTotal_bytes${m(sel)})) * 100`,
    disk_read: `sum(rate(node_disk_read_bytes_total${m(sel)}[5m]))`,
    disk_write: `sum(rate(node_disk_written_bytes_total${m(sel)}[5m]))`,
    network_rx: `sum(rate(node_network_receive_bytes_total${m('device!="lo"', sel)}[5m]))`,
    network_tx: `sum(rate(node_network_transmit_bytes_total${m('device!="lo"', sel)}[5m]))`,
    load1: `max(node_load1${m(sel)})`,
    filesystem: `(1 - sum(node_filesystem_avail_bytes${m('mountpoint="/"', sel)}) / sum(node_filesystem_size_bytes${m('mountpoint="/"', sel)})) * 100`,
  }
}

// The node-exporter figures from hostmetrics: CPU is idle seconds per logical CPU, as node-exporter's
// avg(rate(idle)) counts it (the states can add up to less on a VM). Memory is used / system.memory.limit (an
// optional metric): with the receiver's default MemAvailable gate, "used" is total − MemAvailable; the states do
// not add up to the total. The collector's version is a label (otel_scope_version) and a stopped collector sends
// no staleness marker, so for minutes after an upgrade each series exists twice: `one` takes it once.
const one = (q: string) => `max without (otel_scope_name, otel_scope_version) (${q})`

function hostmetrics(sel: string): Queries {
  const disk = (dir: string) => `sum(${one(`rate(system_disk_io_bytes_total${m(`direction="${dir}"`, `device!~${DISK_EXCLUDE}`, sel)}[5m])`)})`
  const net = (dir: string) => `sum(${one(`rate(system_network_io_bytes_total${m(`direction="${dir}"`, 'device!="lo"', sel)}[5m])`)})`
  return {
    cpu: `100 * (1 - sum(${one(`rate(system_cpu_time_seconds_total${m('state="idle"', sel)}[5m])`)}) / sum(${one(`system_cpu_logical_count${m(sel)}`)}))`,
    memory: `100 * sum(${one(`system_memory_usage_bytes${m('state="used"', sel)}`)}) / sum(${one(`system_memory_limit_bytes${m(sel)}`)})`,
    disk_read: disk('read'),
    disk_write: disk('write'),
    network_rx: net('receive'),
    network_tx: net('transmit'),
    load1: `max(system_cpu_load_average_1m${m(sel)})`,
    filesystem: `100 * (1 - sum(${one(`system_filesystem_usage_bytes${m('state="free"', 'mountpoint="/"', sel)}`)}) / sum(${one(`system_filesystem_usage_bytes${m('mountpoint="/"', sel)}`)}))`,
  }
}

function either(a: Queries, b: Queries): Queries {
  return Object.fromEntries(Object.entries(a).map(([k, q]) => [k, `(${q}) or (${b[k as keyof Queries]})`])) as Queries
}

// The node drawer's queries for one node. Disk and network add up the node's devices (node-exporter's node-mixin).
export function nodeQueries(name: string, addresses: string[] = []): Queries {
  return either(nodeExporter(nodeInstanceSelector(name, addresses)), hostmetrics(nodeNameSelector(name)))
}

// The dashboard's cluster-wide values: every node of the cluster added up.
export function clusterNodeQueries(): Pick<Queries, 'cpu' | 'memory' | 'filesystem'> {
  const { cpu, memory, filesystem } = either(nodeExporter(''), hostmetrics(''))
  return { cpu, memory, filesystem }
}
