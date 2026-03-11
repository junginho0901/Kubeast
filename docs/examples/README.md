# Examples

## DaemonSet Create Test

- File: `daemonset-test.yaml`
- Purpose: quick validation for "Create from YAML" flow and DaemonSet list/detail/watch updates.

Apply command:

```bash
kubectl apply -f docs/examples/daemonset-test.yaml
```

Cleanup command:

```bash
kubectl delete -f docs/examples/daemonset-test.yaml
```
