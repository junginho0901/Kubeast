// Screens that moved: the old address answers with a redirect, so a bookmark or a link in a message keeps working.
export const MOVED_SCREENS = {
  nodeShell: { from: 'admin/node-shell', to: '/account#node-shell' },
  clusterHygiene: { from: 'admin/cluster-hygiene', to: '/cluster/hygiene' },
}

// The new address with the old one's query (?cluster=, ?detail=). The new address's own section wins over the old's.
export function movedAddress(to: string, search: string, hash: string): string {
  const [path, ownHash] = to.split('#')
  return `${path}${search}${ownHash ? `#${ownHash}` : hash}`
}
