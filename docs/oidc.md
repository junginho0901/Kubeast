**English** | [한국어](ko/oidc.md)

# SSO (OIDC) setup

Kubeast can sign people in with one OpenID Connect provider (Keycloak, Google, Entra ID, Okta, etc.).
This document covers creating a client at the provider, setting the chart values, choosing the first admin, and connecting groups to roles.
The authoritative description of the values is `auth.oidc` in [`helm/kubeast/values.yaml`](../helm/kubeast/values.yaml).

## 1. How it works

- Authorization code flow with PKCE (S256). The state, nonce and PKCE verifier are kept in a signed cookie.
- The ID token's signature, issuer, audience (`clientId`), expiry and nonce are checked with the keys from discovery (`<issuerUrl>/.well-known/openid-configuration`).
- If `email_verified` is `false`, the sign-in is refused. If `allowedDomains` is set, only mail addresses in those domains are accepted.
- The account is created at the first sign-in (no password). If an account with the same email already exists, the person signs in to that account.
- Both success and failure are recorded in the audit log: `user.login.success`, or `user.login.failed` with a reason code (§6).

## 2. Common steps

1. **Register a client at the provider**:
   - web application (confidential)
   - redirect URI = `<Kubeast public URL>/api/v1/auth/oidc/callback`
   - scope `openid email profile`. If you use groups, put the group claim in the ID token (§4).
2. **The client secret as a Secret**

   ```bash
   kubectl -n <ns> create secret generic kubeast-oidc --from-literal=client_secret='<secret>'
   ```

   Then set `auth.oidc.existingSecret: kubeast-oidc`.
   To pass it as a value instead, use `clientSecret`; it then becomes `OIDC_CLIENT_SECRET` in `kubeast-secrets`.
   Installs that use `secrets.existingSecret` put `OIDC_CLIENT_SECRET` in that Secret or use `existingSecret`.
3. **Chart values**

   ```yaml
   auth:
     cookieSecure: true          # behind HTTPS. Without the cookie, sign-in fails silently
     oidc:
       enabled: true
       displayName: Company SSO  # text on the sign-in button
       issuerUrl: https://sso.example.com/realms/example
       clientId: kubeast
       existingSecret: kubeast-oidc
       redirectUrl: https://kubeast.example.com/api/v1/auth/oidc/callback
       allowedDomains: [example.com]
       defaultRole: Pending      # people with no mapped group
   ```

4. **Private CA** — if the provider's certificate is signed by an internal CA, put that CA in `customCAs` ([Add a trusted CA](operations.md#adding-trusted-cas-private-cas-tls-intercepting-proxies)). Without it, discovery fails with an x509 error and sign-in comes back with `oidc_provider`.
5. **First admin** — sign in with the chart's `admin` account (password: `DEFAULT_ADMIN_PASSWORD` in `kubeast-secrets`). Then, in Admin → User Management, change your own SSO account to Admin. If group mapping (§3) gives you Admin, this step is not needed.
6. **Reduce password sign-in** — once SSO works, set `auth.passwordLogin: "admin-only"` (only the `admin` account, as an emergency path when the provider is down) or `"off"`.
7. **Check** — click the button on the sign-in screen, sign in at the provider and come back. If the app opens, you are done. On failure the address becomes `/login?error=<code>` and the auth-service log has `oidc: login failed` (§6).

## 3. Connecting roles

Kubeast permissions have two layers.

| Layer | Values | What |
| --- | --- | --- |
| Account level | Admin · custom role · Member · Pending | Admin = everything, Member = approved (permissions come from per-cluster grants), Pending = can sign in, the API returns 403 (waiting for admin approval) |
| Per-cluster grant | Read · Write · Admin (per cluster) | What the person can do on that cluster. The cluster RBAC is the final ceiling ([cluster-requirements §1](cluster-requirements.md)) |

Connect provider groups to both layers.

```yaml
auth:
  oidc:
    claims:
      groups: groups                       # name of the group claim in the ID token
    roleMapping:                           # <group>=<Admin|Member|custom role>
      - kubeast-admins=Admin
      - engineering=Member
    clusterGroupPrefix: "kubeast:cluster:" # a group named <prefix><cluster id>:<Read|Write|Admin> gives that grant
    clusterGroupMapping:                   # groups that cannot be named that way (Google group mail, Entra group ID)
      - platform@example.com=prod:Read
    syncRoles: true
```

- When several groups match, the broader one wins: account level Admin > custom > Member > Pending, per cluster Admin > Write > Read.
- With `syncRoles: true` and **a group claim in the token**, roles are synced again at every sign-in. Remove a group at the provider, and the permission goes too at the next sign-in (`defaultRole` when no group maps).
- **Without a group claim** (Google), permissions an admin gave on screen are not overwritten.
- Namespace-scoped permissions are given through custom roles (`namespaces` in `auth.impersonation.customRoles`).
- The waiting-for-approval screen shows one of two messages:
  - On installs that sync roles from groups at every sign-in, it says "Ask an administrator to add you to a group there, then sign out and sign in again."
    These are installs with `syncRoles` and a provider that sends a group claim, or Google with `googleGroups` on (`roles_from_groups` in `GET /api/v1/auth/oidc/config`).
  - Otherwise it says "Once an administrator assigns your role, sign out and sign in again."

## 4. By provider

### Keycloak

- Client: Client authentication on (confidential), Standard flow, Valid redirect URIs = the callback above, (advanced) PKCE method S256.
- Groups: a **Group Membership** mapper in a client-dedicated scope (or a default scope), with these settings:
  - Token Claim Name `groups`
  - **Full group path off**. When it is on, a `/` is prepended, as in `/kubeast-admins`, and the name does not match `roleMapping`.
  - Add to ID token on
- `issuerUrl`: `https://<keycloak>/realms/<realm>`.
- If Keycloak is open only on a port other than 443 (8443, etc.), add a NetworkPolicy rule for that address and port in `auth.oidc.egress`. By default, auth-service goes out only on 443 and 6443.
- Verified (2026-10-21, Keycloak 26.8.1) with e2e `oidc-keycloak.spec.ts` (`e2e/scripts/oidc-keycloak.sh up`), against a realm set up as above: [`deploy/kind/keycloak-realm.json`](../deploy/kind/keycloak-realm.json), with groups `sre`, `dev`, `viewer` and PKCE S256 required.
  - Groups map to the account level and cluster roles.
  - People without a group are Pending.
  - Moving someone to another group in Keycloak changes their cluster role at the next sign-in and records `user.cluster_role.set` (`via: oidc`).
  - Kubeast sign-out ends only the Kubeast session and leaves the Keycloak session. Signing in again in the same browser does not ask for the password.

### Google

- Google Auth Platform → Branding (User type **Internal**) → Clients → Web application, Authorized redirect URI = the callback above.
- `issuerUrl: https://accounts.google.com`, `allowedDomains: [<Workspace domain>]` (without it, any Google account gets a Pending account).
- **Google ID tokens have no groups.** Pick one of two:
  - An admin grants roles in User Management (default `defaultRole: Pending` → approval). `syncRoles` does not overwrite them.
  - `auth.oidc.googleGroups.enabled: true`: at sign-in, Kubeast reads the person's Workspace groups through the Admin SDK Directory API and uses only those that match the mapping.
    - The service account needs the Workspace admin role **Groups Reader** (no domain-wide delegation).
    - Its credentials are `credentials.json` in a Secret. With Workload Identity Federation there is no key; set `tokenAudience`.
    - Set `domain` to the Workspace domain.
    - Preview: `GET /api/v1/auth/admin/oidc/groups?email=<mail>`.
    - Google group names are mail addresses, so use `clusterGroupMapping`.

### Microsoft Entra ID

- App registration → Web redirect URI = the callback above, issue a client secret. `issuerUrl: https://login.microsoftonline.com/<tenant-id>/v2.0`.
- The group claim (Token configuration → groups claim) defaults to **group object IDs**, so write the IDs in `clusterGroupMapping` and `roleMapping`.

### Okta

- OIDC Web Application, Sign-in redirect URI = the callback above. `issuerUrl` is the authorization server you use (`https://<org>.okta.com/oauth2/default`, etc.).
- For groups, put the authorization server's claim (`groups`, scope limited with a filter) in the ID token.

## 5. Kubernetes side

A signed-in person's requests go to the target cluster as **that person's email + the group `kubeast:viewer`/`operator`/`admin`** (impersonation).
Provider groups do not go to the cluster RBAC directly.
For the cluster-side bindings, see [cluster-requirements §1](cluster-requirements.md).

## 6. Sign-in failure codes

| `/login?error=` | Meaning | Where to look |
| --- | --- | --- |
| `oidc_provider` | Discovery failed (address, network, TLS) | `issuerUrl`, NetworkPolicy egress, private CA (`customCAs`) |
| `oidc_state` | The state cookie is missing or does not match | `cookieSecure` and the access scheme (Secure cookies are dropped over HTTP), another tab, expiry |
| `oidc_denied` | The provider refused (`error=` response) | User assignment and consent at the provider |
| `oidc_exchange` | The code → token exchange failed | Client secret, redirect URI match |
| `oidc_token` | No ID token, or verification failed (signature, audience, expiry, nonce) | `clientId`, clock |
| `oidc_no_email` | No email claim | Scope `email`, `claims.email` |
| `oidc_email_unverified` | `email_verified=false` | Email verification at the provider |
| `oidc_domain` | Outside `allowedDomains` | The value |
| `oidc_provision` | Creating the account or applying the role failed | The role names in `roleMapping` (a role that does not exist fails), DB |
