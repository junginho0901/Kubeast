# Supply chain: scan, SBOM, provenance, signature

Every release (`v*` tag, `.github/workflows/release.yaml`) publishes the seven
images to ghcr.io and, per image, by digest:

| Step | What it produces | Fails the release when |
|---|---|---|
| trivy (`aquasecurity/trivy-action`) | vulnerability report in the job log | a **fixed** CRITICAL or HIGH vulnerability is found (`ignore-unfixed`: findings without an upstream fix are reported but do not block) |
| syft (`anchore/sbom-action`) | SBOM in SPDX JSON, also a workflow artifact `sbom-<service>.spdx.json` | SBOM generation error |
| `actions/attest-sbom` | SBOM attestation pushed to the registry next to the image (Sigstore, GitHub OIDC identity) | attestation error |
| `actions/attest-build-provenance` | SLSA build-provenance attestation (which workflow, commit and runner built the image) pushed to the registry | attestation error |
| cosign keyless (`cosign sign --yes IMAGE@DIGEST`) | signature in the registry, entry in the Rekor transparency log | signing error |

The repository is public, so GitHub's attestations and the Sigstore public
instance cost nothing and there is no key to keep: the signing identity is the
release workflow itself (`https://github.com/junginho0901/Kubeast/.github/workflows/release.yaml@refs/tags/vX.Y.Z`).

## Verifying an image

```bash
IMG=ghcr.io/junginho0901/kubeast-auth-service:v0.4.0

# provenance and SBOM attestations (GitHub CLI 2.49+)
gh attestation verify oci://$IMG -R junginho0901/Kubeast
gh attestation verify oci://$IMG -R junginho0901/Kubeast --predicate-type https://spdx.dev/Document/v2.3

# cosign signature (keyless: the certificate names the workflow that signed)
cosign verify \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github.com/junginho0901/Kubeast/\.github/workflows/release\.yaml@refs/tags/v' \
  $IMG

# the SBOM itself
gh attestation verify oci://$IMG -R junginho0901/Kubeast --predicate-type https://spdx.dev/Document/v2.3 --format json \
  | jq '.[0].verificationResult.statement.predicate' > sbom.spdx.json
```

`gh attestation verify` also accepts `--format json` for the full statement,
and both commands work offline against a digest pinned in your values
(`global.imageTag` may be a digest-pinned tag once the chart supports it).

## Enforcing it in a cluster

The workflow only produces the evidence. To refuse unsigned images at admission,
use an image-verification policy in the target cluster, for example Kyverno
`verifyImages` with the keyless issuer/subject above, or Sigstore's
policy-controller. That is a cluster-side setting and is not part of the chart.

## Not covered yet

- The Helm chart pushed to `oci://ghcr.io/<owner>/charts` is not signed or
  attested yet.
- Scanning runs at release time only; there is no scheduled rescan of already
  published images.
