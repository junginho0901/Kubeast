// PromQL for one node's node-exporter series. node-exporter's `instance` is the node name in some installs and
// `<node IP>:9100` in the prometheus and kube-prometheus-stack charts, so the selector takes either, matched whole.

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// instance=~"(?:<name>|<ip>…)(?::[0-9]+)?" — Prometheus anchors the regular expression, so node-1 does not match
// node-10. An IPv6 address appears in brackets.
export function nodeInstanceSelector(name: string, addresses: string[] = []): string {
  const hosts = [name, ...addresses]
    .filter((h, i, all) => h && all.indexOf(h) === i)
    .map((h) => (h.includes(':') ? `\\[${escapeRegex(h)}\\]` : escapeRegex(h)))
  const re = `(?:${hosts.join('|')})(?::[0-9]+)?`
  return `instance=~"${re.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

// The node drawer's queries. Disk and network add up the node's devices (node-exporter's node-mixin rules).
export function nodeQueries(sel: string) {
  return {
    cpu: `100 - (avg by(instance)(rate(node_cpu_seconds_total{mode="idle",${sel}}[5m])) * 100)`,
    memory: `(1 - node_memory_MemAvailable_bytes{${sel}} / node_memory_MemTotal_bytes{${sel}}) * 100`,
    disk_read: `sum by(instance)(rate(node_disk_read_bytes_total{${sel}}[5m]))`,
    disk_write: `sum by(instance)(rate(node_disk_written_bytes_total{${sel}}[5m]))`,
    network_rx: `sum by(instance)(rate(node_network_receive_bytes_total{device!="lo",${sel}}[5m]))`,
    network_tx: `sum by(instance)(rate(node_network_transmit_bytes_total{device!="lo",${sel}}[5m]))`,
    load1: `node_load1{${sel}}`,
    filesystem: `(1 - node_filesystem_avail_bytes{mountpoint="/",${sel}} / node_filesystem_size_bytes{mountpoint="/",${sel}}) * 100`,
  }
}
