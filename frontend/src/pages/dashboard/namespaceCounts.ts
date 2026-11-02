// The Namespaces window's per-namespace counts, from lists the caller reads: the pods counted per namespace by the
// pods page (`by_namespace`) and every namespace's Services and Deployments. A kind whose list failed or has not
// come yet has no count (the window shows -), and so has a namespace the server folded into "(other)".

export interface NamespaceCounts {
  pods?: number
  services?: number
  deployments?: number
}

const perNamespace = (items: { namespace?: string }[]) => {
  const m = new Map<string, number>()
  for (const it of items) if (it.namespace) m.set(it.namespace, (m.get(it.namespace) ?? 0) + 1)
  return m
}

export function namespaceCounts(
  names: string[],
  podGroups: { name: string; count: number }[] | undefined,
  services: { namespace?: string }[] | undefined,
  deployments: { namespace?: string }[] | undefined,
): Record<string, NamespaceCounts> {
  const pods = podGroups ? new Map(podGroups.map((g) => [g.name, g.count])) : undefined
  const folded = pods?.has('(other)') ?? false
  const svc = services ? perNamespace(services) : undefined
  const dep = deployments ? perNamespace(deployments) : undefined
  const out: Record<string, NamespaceCounts> = {}
  for (const name of names) {
    out[name] = {
      pods: pods ? (pods.get(name) ?? (folded ? undefined : 0)) : undefined,
      services: svc ? (svc.get(name) ?? 0) : undefined,
      deployments: dep ? (dep.get(name) ?? 0) : undefined,
    }
  }
  return out
}
