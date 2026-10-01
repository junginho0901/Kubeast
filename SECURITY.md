# Security policy

## Reporting a vulnerability

Please report security issues privately — do not open a public issue.

- Preferred: GitHub private vulnerability reporting on this repository
  (**Security → Report a vulnerability**).
- The report should say which component is affected (gateway, auth-service,
  k8s-service, session-service, ai-service, tool-server, controller, frontend,
  Helm chart), the version or commit, and steps to reproduce.

You will get an acknowledgement within 7 days and a fix or a mitigation plan
within 30 days for confirmed issues. Fixed versions are published as GitHub
releases; the release notes name the issue once a fix is available.

## Supported versions

Only the latest minor release line receives security fixes.

## What ships with a release

Every release image is scanned (fixed CRITICAL/HIGH vulnerabilities fail the
release), carries an SPDX SBOM and a build-provenance attestation, and is
signed with cosign (keyless, GitHub OIDC). The Helm chart is attested and
signed the same way. See [docs/supply-chain.md](docs/supply-chain.md) for how
to verify them.
