// The object a CRD's printer columns are read from (JSONPath): the describe answer's metadata, spec and status,
// and what some kinds keep beside them (`fields` — a PolicyReport's scope, summary and results).
export function printerColumnObject(describe: Record<string, any>): Record<string, unknown> {
  return {
    ...(describe.fields ?? {}),
    metadata: {
      name: describe.name,
      namespace: describe.namespace,
      uid: describe.uid,
      creationTimestamp: describe.created_at,
      labels: describe.labels,
      annotations: describe.annotations,
    },
    spec: describe.spec || {},
    status: describe.status || {},
  }
}
