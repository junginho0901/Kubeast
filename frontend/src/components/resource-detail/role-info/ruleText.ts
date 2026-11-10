// A rule's API groups as the Role, ClusterRole and ServiceAccount drawers write them: the core group's name is empty, so it reads "".
export function ruleApiGroupsText(groups: unknown): string {
  const list = Array.isArray(groups) ? groups : []
  return list.length > 0 ? list.map((g) => String(g || '""')).join(', ') : '-'
}
