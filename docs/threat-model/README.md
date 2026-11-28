# Threat model

Each release writes one page covering only what that release changes. The pages follow the four questions of the [OWASP Threat Modeling Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Threat_Modeling_Cheat_Sheet.html): what are we working on, what can go wrong, what are we going to do about it, did we do a good enough job. No page joins them yet into one model of the whole system with its module boundaries.

| Release | What it changes | Page |
| --- | --- | --- |
| v0.7.8 | A stream server for terminals and followed logs, state moving from a server's memory to PostgreSQL and Redis, several k8s-service and tool-server replicas and HPA, role names and the cluster groups they give | [v0.7.8](v0.7.8.md) |
| v0.7.9 | What the AI reads from the cluster, new AI tools, password sign-in of SSO accounts | [v0.7.9](v0.7.9.md) |
| v0.8.0 | The screens (the restyle and the keyboard), log search across Namespaces and places shared between clusters, answers built once for many and approved AI writes at shutdown, what the AI reads and says, which model answers, an alert's earlier investigations, sign-in groups, model providers and audit sinks, FlowSchemas | [v0.8.0](v0.8.0.md) |

Beside the release pages, the [ASVS 5.0 self-check](asvs-5.0.md) checks the whole of Kubeast against the OWASP ASVS 5.0.0: every level 1 requirement and the level 2 areas it names. It is read again against each release's tree.

How a page is written:

- A data-flow sketch with its trust boundaries, then one table per change: the threat and its STRIDE letter, where it is (a file or route), what stops it (a pointer to code or to a decided plan line), what is left before the release and which step owns it, and how it is checked (a test, a guard spec, a fault test).
- Every "what stops it" cell says whether the control is in `main`, in an unmerged draft, or only in the plan. What has not been checked is written as unconfirmed, with what to check.
- A gap in released code is described by what is missing and how it is fixed, not by how to use it. Security problems are reported privately, as [SECURITY.md](../../SECURITY.md) says.
- The page is read again against the merged code before the release, and its statuses are updated.
