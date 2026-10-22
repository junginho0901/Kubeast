# SSO(OIDC) 설정

Kubeast는 OpenID Connect 공급자 하나로 로그인할 수 있습니다(Keycloak, Google, Entra ID, Okta 등). 이 문서는 공급자에 클라이언트를 만들고, 차트 값을 넣고, 첫 관리자를 정하고, 그룹을 역할에 연결하는 순서입니다. 값의 설명은 [`helm/kubeast/values.yaml`](../helm/kubeast/values.yaml)의 `auth.oidc`가 정본입니다.

## 1. 동작

- authorization code + PKCE(S256). state·nonce·PKCE verifier는 서명한 쿠키에 담습니다.
- ID 토큰은 discovery(`<issuerUrl>/.well-known/openid-configuration`)의 키로 서명·issuer·audience(`clientId`)·만료·nonce를 확인합니다.
- `email_verified`가 `false`면 거부합니다. `allowedDomains`가 있으면 그 도메인 메일만 받습니다.
- 첫 로그인에 계정을 만듭니다(비밀번호 없음). 같은 이메일의 계정이 이미 있으면 그 계정으로 로그인합니다.
- 성공·실패 모두 감사 로그에 남습니다(`user.login.success`, 실패는 `user.login.failed` + 사유 코드, §6).

## 2. 공통 순서

1. **공급자에 클라이언트 등록** — 웹 애플리케이션(confidential), redirect URI = `<Kubeast 공개 주소>/api/v1/auth/oidc/callback`, scope `openid email profile`(그룹을 쓰면 그룹 클레임이 ID 토큰에 들어오게, §4).
2. **client secret을 Secret으로**

   ```bash
   kubectl -n <ns> create secret generic kubeast-oidc --from-literal=client_secret='<secret>'
   ```

   `auth.oidc.existingSecret: kubeast-oidc`. 값으로 넣으려면 `clientSecret`(그러면 `kubeast-secrets`의 `OIDC_CLIENT_SECRET`). `secrets.existingSecret`을 쓰는 설치는 그 Secret에 `OIDC_CLIENT_SECRET`을 넣거나 `existingSecret`을 씁니다.
3. **차트 값**

   ```yaml
   auth:
     cookieSecure: true          # HTTPS 뒤에서. 쿠키가 안 붙으면 로그인이 조용히 실패한다
     oidc:
       enabled: true
       displayName: Company SSO  # 로그인 버튼 글자
       issuerUrl: https://sso.example.com/realms/example
       clientId: kubeast
       existingSecret: kubeast-oidc
       redirectUrl: https://kubeast.example.com/api/v1/auth/oidc/callback
       allowedDomains: [example.com]
       defaultRole: Pending      # 매핑되는 그룹이 없는 사람
   ```

4. **사설 CA** — 공급자 인증서가 사내 CA로 서명됐으면 `customCAs`에 그 CA를 넣습니다([신뢰할 CA 추가](operations.md#신뢰할-ca-추가-사설-catls-가로채는-프록시)). 없으면 discovery가 x509 오류로 실패하고 로그인은 `oidc_provider`로 돌아옵니다.
5. **첫 관리자** — 차트의 `admin` 계정(비밀번호, `kubeast-secrets`의 `DEFAULT_ADMIN_PASSWORD`)으로 로그인 → Admin → User Management에서 본인 SSO 계정을 Admin으로 바꿉니다. 그룹 매핑(§3)으로 Admin을 주면 이 단계는 없습니다.
6. **비밀번호 로그인 줄이기** — SSO가 돌면 `auth.passwordLogin: "admin-only"`(공급자 장애 때 `admin` 계정만 비상 경로로) 또는 `"off"`.
7. **확인** — 로그인 화면의 버튼 → 공급자 → 돌아와 앱이 열리면 끝. 실패하면 주소가 `/login?error=<코드>`가 되고 auth-service 로그에 `oidc: login failed`가 남습니다(§6).

## 3. 역할 연결

Kubeast 권한은 두 층입니다.

| 층 | 값 | 무엇 |
| --- | --- | --- |
| 계정 등급 | Admin · 커스텀 역할 · Member · Pending | Admin = 전부, Member = 승인됨(권한은 클러스터별 부여에서), Pending = 로그인은 되고 API는 403(관리자 승인 대기) |
| 클러스터별 부여 | Read · Write · Admin(클러스터마다) | 그 클러스터에서 할 수 있는 일. 클러스터 RBAC이 최종 상한([cluster-requirements §1](cluster-requirements.md)) |

공급자 그룹을 두 층에 연결합니다.

```yaml
auth:
  oidc:
    claims:
      groups: groups                       # ID 토큰의 그룹 클레임 이름
    roleMapping:                           # <그룹>=<Admin|Member|커스텀 역할>
      - kubeast-admins=Admin
      - engineering=Member
    clusterGroupPrefix: "kubeast:cluster:" # 그룹 이름이 <접두><클러스터 id>:<Read|Write|Admin>이면 그 부여
    clusterGroupMapping:                   # 이름을 그렇게 못 짓는 그룹(Google 그룹 메일, Entra 그룹 ID)
      - platform@example.com=prod:Read
    syncRoles: true
```

- 여러 그룹이 걸리면 넓은 쪽: 계정 등급 Admin > 커스텀 > Member > Pending, 클러스터별 Admin > Write > Read.
- `syncRoles: true`이고 **토큰에 그룹 클레임이 있으면** 로그인마다 다시 맞춥니다 — 공급자에서 그룹을 빼면 다음 로그인에 권한도 빠집니다(매핑되는 그룹이 없으면 `defaultRole`). **그룹 클레임이 없으면**(Google) 관리자가 화면에서 준 권한을 덮어쓰지 않습니다.
- Namespace 범위 권한은 커스텀 역할(`auth.impersonation.customRoles`의 `namespaces`)로 줍니다.
- 승인 대기 화면: 로그인마다 그룹으로 역할을 다시 맞추는 설치(`syncRoles`이고 그룹 클레임을 받는 공급자, Google은 `googleGroups`를 켰을 때 — `GET /api/v1/auth/oidc/config`의 `roles_from_groups`)면 "관리자에게 그룹 추가를 요청하세요"라고 안내합니다. 그 밖에는 "관리자가 역할을 부여하면 다시 로그인하세요"입니다.

## 4. 공급자별

### Keycloak

- 클라이언트: Client authentication 켬(confidential), Standard flow, Valid redirect URIs = 위 callback, (고급) PKCE method S256.
- 그룹: 클라이언트 전용 scope(또는 기본 scope)에 **Group Membership** 매퍼 — Token Claim Name `groups`, **Full group path 끔**(켜면 `/kubeast-admins`처럼 앞에 `/`가 붙어 `roleMapping`과 안 맞음), Add to ID token 켬.
- `issuerUrl`: `https://<keycloak>/realms/<realm>`.
- Keycloak이 443이 아닌 포트(8443 등)로만 열려 있으면 `auth.oidc.egress`에 그 주소·포트의 NetworkPolicy 규칙을 넣습니다(auth-service는 기본으로 443·6443만 나감).
- 확인함(2026-10-21, Keycloak 26.8.1): 위 설정의 렐름([`deploy/kind/keycloak-realm.json`](../deploy/kind/keycloak-realm.json) — 그룹 `sre`·`dev`·`viewer`, PKCE S256 필수)으로 그룹 → 계정 등급·클러스터 역할, 그룹 없는 사람 Pending, Keycloak에서 그룹을 옮기면 다음 로그인 때 클러스터 역할이 바뀌고 `user.cluster_role.set`(`via: oidc`)이 남음(e2e `oidc-keycloak.spec.ts`, `e2e/scripts/oidc-keycloak.sh up`).
  - Kubeast 로그아웃은 Kubeast 세션만 끝내고 Keycloak 세션은 남깁니다 — 같은 브라우저에서 다시 로그인하면 비밀번호를 묻지 않습니다.

### Google

- Google Auth Platform → Branding(User type **Internal**) → Clients → Web application, Authorized redirect URI = 위 callback.
- `issuerUrl: https://accounts.google.com`, `allowedDomains: [<Workspace 도메인>]`(없으면 아무 Google 계정이나 Pending 계정이 생김).
- **Google ID 토큰에는 그룹이 없습니다.** 둘 중 하나:
  - 관리자가 User Management에서 부여(기본 `defaultRole: Pending` → 승인). `syncRoles`가 덮어쓰지 않습니다.
  - `auth.oidc.googleGroups.enabled: true` — 로그인 때 Admin SDK Directory API로 그 사람의 Workspace 그룹을 읽어 매핑에 걸리는 것만 씁니다. 서비스 계정에 Workspace 관리자 역할 **Groups Reader**(도메인 전체 위임 없음), 자격은 Secret의 `credentials.json`(Workload Identity Federation이면 키 없음, `tokenAudience` 설정), `domain` = Workspace 도메인. 미리 보기: `GET /api/v1/auth/admin/oidc/groups?email=<메일>`. Google 그룹은 이름이 메일 주소라 `clusterGroupMapping`을 씁니다.

### Microsoft Entra ID

- 앱 등록 → Web redirect URI = 위 callback, client secret 발급. `issuerUrl: https://login.microsoftonline.com/<tenant-id>/v2.0`.
- 그룹 클레임(Token configuration → groups claim)은 기본이 **그룹 객체 ID** → `clusterGroupMapping`·`roleMapping`에 ID를 적습니다.

### Okta

- OIDC Web Application, Sign-in redirect URI = 위 callback. `issuerUrl`은 쓰는 authorization server(`https://<org>.okta.com/oauth2/default` 등).
- 그룹은 authorization server의 claim(`groups`, filter로 범위 제한)을 ID 토큰에 넣습니다.

## 5. Kubernetes 쪽

로그인한 사람은 대상 클러스터에 **그 사람 이메일 + 그룹 `kubeast:viewer`/`operator`/`admin`**으로 요청됩니다(impersonation). 공급자 그룹이 클러스터 RBAC에 직접 가지는 않습니다. 클러스터 쪽 바인딩은 [cluster-requirements §1](cluster-requirements.md).

## 6. 로그인 실패 코드

| `/login?error=` | 뜻 | 볼 곳 |
| --- | --- | --- |
| `oidc_provider` | discovery 실패(주소·네트워크·TLS) | `issuerUrl`, NetworkPolicy egress, 사설 CA(`customCAs`) |
| `oidc_state` | state 쿠키가 없거나 안 맞음 | `cookieSecure`와 접속 스킴(HTTP에서 Secure 쿠키는 버려짐), 다른 탭·만료 |
| `oidc_denied` | 공급자가 거부(`error=` 응답) | 공급자 쪽 사용자 할당·동의 |
| `oidc_exchange` | code → 토큰 교환 실패 | client secret, redirect URI 일치 |
| `oidc_token` | ID 토큰 없음·검증 실패(서명·audience·만료·nonce) | `clientId`, 시계 |
| `oidc_no_email` | 이메일 클레임 없음 | scope `email`, `claims.email` |
| `oidc_email_unverified` | `email_verified=false` | 공급자의 메일 확인 |
| `oidc_domain` | `allowedDomains` 밖 | 값 |
| `oidc_provision` | 계정 만들기·역할 반영 실패 | `roleMapping`의 역할 이름(없는 역할이면 실패), DB |
