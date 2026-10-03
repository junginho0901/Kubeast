// Ingress path backend as the k8s-service serialises it (`service_name` /
// `service_port` / `service_port_name`), with the raw Kubernetes shape
// (`service.name` / `service.port.number|name`) accepted as well so a watch
// event object renders the same way.

export function backendService(backend: any): string | null {
  return backend?.service_name || backend?.service?.name || null
}

export function backendPort(backend: any): string {
  const port = backend?.service_port ?? backend?.service?.port?.number ?? backend?.service_port_name ?? backend?.service?.port?.name
  return port == null || port === '' ? '' : String(port)
}
