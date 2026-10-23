# <img src="frontend/public/icon.svg" alt="" width="40" height="40" align="top"> Kubeast

**English** | [한국어](README.ko.md)

A multi-cluster Kubernetes operations platform with a built-in AI assistant. In the web UI you can view and manage resources across multiple clusters (Workloads, Network, Storage, RBAC, GPU, Helm, etc.), and use LLM-based chat to view, diagnose and change resources.

Key features:

- AI assistant with multiple LLMs (OpenAI · Anthropic · Gemini · Azure OpenAI · Ollama), cluster operations through tool calling
- When an alert (Alertmanager · Grafana) arrives, the AI investigates it with read tools and leaves a report
- Multi-cluster management and per-user × per-cluster RBAC, temporary access requests and approvals
- Helm release management (rollback / upgrade / uninstall / test)
- GPU & DRA monitoring, Prometheus metrics, log search (Loki), topology visualization, Node Shell
- Audit log (hash chain) for every write/sensitive operation, terminal session recording
- MCP server for external AI agents
- One-line install from public container images (ghcr.io) (Kubernetes / Docker)
- Korean · English support

## Quick start

```bash
helm install kubeast oci://ghcr.io/junginho0901/charts/kubeast --version 0.7.0 \
  --namespace kubeast --create-namespace
```

The install script, Docker Compose, uninstalling, finding the admin password, connecting a cluster and turning on AI are covered in [Installation and first setup](docs/getting-started.md).

## Documentation

| Document | Contents |
| --- | --- |
| [Installation and first setup](docs/getting-started.md) | 3 install methods · uninstall · first access · connecting a cluster · turning on AI |
| [Features at a glance](docs/features.md) | AI assistant · multi-cluster, roles and permissions · resource management · Helm · GPU · observability · authentication and audit |
| [AI and alerts](docs/ai-alerts.md) | MCP server · alert → AI investigation · Alerts inbox · reading traces and alerts · AI analysis evaluation |
| [Security and audit](docs/security-audit.md) | API keys · access review · dormant account lockout · audit sinks · audit log integrity · session recording |
| [Operations features](docs/operations.md) | Policy reports · cluster hygiene check · Argo CD guard · dashboard quick actions · log files · log search · trace links · trusted CAs |
| [Cluster requirements](docs/cluster-requirements.md) | What the clusters you manage must have (RBAC · metrics-server · Prometheus · OpenCost, etc.) and how to check |
| [SSO (OIDC) setup](docs/oidc.md) | Connecting Keycloak · Google · Entra ID · Okta |
| [Architecture](docs/architecture.md) | Services · container images · resource usage |
| [Configuration (values.yaml)](docs/configuration.md) | Chart values explained |
| [Database: TLS, backup and restore](docs/database-backup-restore.md) | DB connection TLS · backup and restore · retention |
| [Console metrics](docs/metrics.md) | Kubeast's own `/metrics` |
| [Supply chain](docs/supply-chain.md) | Image scanning · SBOM · provenance attestation · signing |
| [Audit log plan](docs/audit-log-plan.md) | Audit action catalog and permission mapping |
| [Development](docs/development.md) | Directory layout · kind dev loop · E2E · per-service development · tech stack |

## License

MIT License
