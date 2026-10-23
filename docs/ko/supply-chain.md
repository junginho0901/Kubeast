[English](../supply-chain.md) | **한국어**

# 공급망: 스캔, SBOM, 출처 증명, 서명

모든 릴리스(`v*` 태그, `.github/workflows/release.yaml`)는 이미지 7개를 ghcr.io에 게시하고, Claude Code가 들어 있는 ai-service도 `kubeast-ai-service:vX.Y.Z-claude-code`로 함께 게시합니다.
차트는 `ai.providers.claudeCode.enabled`가 켜져 있을 때 이 이미지를 쓰며, 이 이미지의 SBOM 아티팩트는 `sbom-ai-service-claude-code.spdx.json`입니다.

- 각 이미지는 **먼저 digest로** push하고, 아래 단계를 그 digest에 대해 실행합니다.
- 버전 태그(`:vX.Y.Z`)는 마지막 단계까지 성공해야 붙입니다. 그래서 게이트에서 실패한 릴리스는 태그로 pull할 수 있는 것을 하나도 남기지 않습니다.
- 태그를 붙이기 전에 push한 digest로 Docker Compose 설치(`install-docker.sh`)를 띄우고 관리자 로그인까지 확인합니다(`scripts/compose-smoke.sh`). 모든 컨테이너가 재시작 없이 떠 있어야 통과합니다.
- `latest` 태그는 없습니다.
- 워크플로가 쓰는 action은 커밋 SHA로 고정하고(`uses: owner/repo@<sha> # vX.Y.Z`), Dependabot이 갱신합니다.

`vX.Y.Z` 태그를 달기 전에 할 일은 다음과 같습니다.

- `deploy/dependencies.yaml`의 `kubeast`를 `X.Y.Z`로 바꾸고, 그 파일에 나열된 모든 곳(`install.sh`, `docker-compose.yml`, README와 `docs/ko/getting-started.md`의 설치 줄)도 함께 바꾸세요.
  - 이 값들이 서로 맞는지는 CI가 확인합니다.
  - 워크플로의 첫 단계가 값이 다른 태그를 멈추므로, 설치 문서와 `install.sh`는 항상 함께 나가는 릴리스를 가리킵니다.
- 태그를 push하기 전에 워크플로를 수동으로(workflow_dispatch) 실행하세요.
  - 이 dry run은 모든 이미지를 push하지 않고 빌드한 뒤 amd64 변형을 같은 trivy 게이트로 검사합니다.
  - 같은 커밋으로 빌드한 이미지로 Compose 설치도 띄워 봅니다(`scripts/compose-smoke.sh --build`).
  - 그래서 태그는 게이트를 통과한 뒤에 push하게 됩니다.

설치 문서와 `install.sh`는 릴리스된 OCI 차트를 설치하며, 그 차트의 이미지 태그는 워크플로가 패키징할 때 정합니다.
체크아웃한 소스의 차트에는 자리표시 태그가 그대로 남습니다.

이미지마다 digest를 기준으로 다음 단계를 실행합니다.

| 단계 | 만드는 것 | 릴리스를 실패시키는 경우 |
|---|---|---|
| 아키텍처 확인 | 플랫폼 변형마다 이미지 주 바이너리를 `file`로 설명한 한 줄 | 변형의 바이너리가 그 플랫폼용으로 빌드되지 않았을 때(v0.3.0/v0.4.0의 이미지 두 개처럼 arm64 변형에 x86-64 바이너리가 들어 있는 경우) |
| trivy (`aquasecurity/trivy-action`) | job 로그에 남는 취약점 보고서 | **수정판이 있는** CRITICAL 또는 HIGH 취약점이 발견될 때. upstream 수정이 없는 항목은 보고만 하고 막지 않습니다(`ignore-unfixed`) |
| syft (`anchore/sbom-action`) | SPDX JSON 형식의 SBOM. 워크플로 아티팩트 `sbom-<service>.spdx.json`으로도 남깁니다 | SBOM 생성 오류 |
| `actions/attest-sbom` | 레지스트리의 이미지 옆에 push하는 SBOM attestation(Sigstore, GitHub OIDC 신원) | attestation 오류 |
| `actions/attest-build-provenance` | 어느 워크플로·커밋·러너가 이미지를 빌드했는지 담아 레지스트리에 push하는 SLSA 빌드 출처(build provenance) attestation | attestation 오류 |
| cosign keyless (`cosign sign --yes IMAGE@DIGEST`) | 레지스트리에 올라가는 서명과 Rekor 투명성 로그 항목 | 서명 오류 |

Helm 차트(`oci://ghcr.io/<owner>/charts/kubeast`)도 `helm push`한 뒤 그 OCI digest에 같은 빌드 출처 attestation과 keyless 서명을 붙입니다.

저장소가 공개이므로 GitHub attestation과 Sigstore 공개 인스턴스를 비용 없이 쓰고, 따로 보관할 키도 없습니다. 서명 신원은 릴리스 워크플로 자체입니다(`https://github.com/junginho0901/Kubeast/.github/workflows/release.yaml@refs/tags/vX.Y.Z`).

## 이미지 검증 (Verifying an image)

```bash
IMG=ghcr.io/junginho0901/kubeast-auth-service:v0.4.0

# 출처 증명과 SBOM attestation (GitHub CLI 2.49+)
gh attestation verify oci://$IMG -R junginho0901/Kubeast
gh attestation verify oci://$IMG -R junginho0901/Kubeast --predicate-type https://spdx.dev/Document/v2.3

# cosign 서명 (keyless: 인증서에 서명한 워크플로가 적혀 있음)
cosign verify \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github.com/junginho0901/Kubeast/\.github/workflows/release\.yaml@refs/tags/v' \
  $IMG

# SBOM 자체
gh attestation verify oci://$IMG -R junginho0901/Kubeast --predicate-type https://spdx.dev/Document/v2.3 --format json \
  | jq '.[0].verificationResult.statement.predicate' > sbom.spdx.json
```

## 차트 검증 (Verifying the chart)

```bash
CHART=ghcr.io/junginho0901/charts/kubeast:0.4.2

gh attestation verify oci://$CHART -R junginho0901/Kubeast
cosign verify \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github.com/junginho0901/Kubeast/\.github/workflows/release\.yaml@refs/tags/v' \
  $CHART
```

전체 statement를 보려면 `gh attestation verify`에 `--format json`을 붙이세요. 두 명령 모두 values에 고정한 digest를 대상으로 오프라인으로 동작합니다. 차트가 지원하게 되면 `global.imageTag`에 digest로 고정한 태그를 쓸 수 있습니다.

## 클러스터에서 강제하기 (Enforcing it in a cluster)

워크플로는 증거를 만들 뿐입니다. 서명 없는 이미지를 admission 단계에서 거부하려면 대상 클러스터에 이미지 검증 정책을 두세요. 예를 들어 위의 keyless issuer/subject를 쓰는 Kyverno `verifyImages`나 Sigstore의 policy-controller를 쓸 수 있습니다. 이 정책은 클러스터 쪽 설정이며 차트에는 들어 있지 않습니다.

## 아직 다루지 않는 것 (Not covered yet)

- 스캔은 릴리스할 때만 실행합니다. 이미 게시한 이미지를 주기적으로 다시 스캔하지는 않습니다.
