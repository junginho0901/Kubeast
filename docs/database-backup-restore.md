**English** | [한국어](ko/database-backup-restore.md)

# Database: TLS, backup and restore

Kubeast keeps its durable state in one PostgreSQL database (users, roles,
registered clusters, chat sessions and messages, tool approvals, model
configs, audit log). This page covers how the services connect to it over TLS,
and how to back up and restore the in-cluster database the chart installs by
default. The procedure below was rehearsed on kind: dump → uninstall + PVC
delete → reinstall → restore → check login, row counts and registered clusters.

## What lives where

| Data | Where | Backed up by |
|---|---|---|
| Tables (see `services/pkg/dbmigrate/migrations`) | PostgreSQL | `pg_dump` / volume snapshot |
| Admin password, JWT signing keys | Secrets `kubeast-secrets`, `kubeast-auth-keys` (kept on uninstall; or your own via `secrets.existingSecret` / `auth.signingKey.existingSecret`) | your Secret source (ESO, sealed-secrets, …) — **not** in the database dump |
| kubeconfigs of registered clusters | Secrets created by auth-service in the release namespace (`clusters.kubeconfig_secret_name`); in-cluster (`self`) mode has none | same — a restored database row without its Secret needs the cluster re-registered |
| LLM API keys | Secret named by `model_configs.api_key_secret_name` | same |

A database restore therefore brings back users, permissions, audit history,
chat history and cluster registrations. The Secrets next to it must come from
their own source of truth.

## TLS to the database

`DATABASE_URL` is one URL read by every service. The Go services (pgx) and the
ai-service (asyncpg, translated in `app/db_ssl.py`) both honour libpq's
`sslmode` and `sslrootcert` in it.

| values | effect |
|---|---|
| `postgresql.sslMode: ""` (default) | no parameter → the drivers' default `prefer`: TLS if the server offers it, otherwise plaintext, no certificate verification. Fine for the in-cluster database on the pod network. |
| `postgresql.sslMode: require` | TLS mandatory, certificate not verified |
| `postgresql.sslMode: verify-full` + `postgresql.sslRootCert.secretName` | TLS, certificate chain and host name verified against the CA in that Secret (mounted at `/etc/kubeast/db-ca/<key>` in every database client pod and the migration Job) |

External database example (RDS for PostgreSQL, where `rds.force_ssl` is on by
default from version 15):

```yaml
postgresql:
  enabled: false
  externalHost: kubeast.abc123.ap-northeast-2.rds.amazonaws.com
  sslMode: verify-full
  sslRootCert:
    secretName: rds-ca          # kubectl create secret generic rds-ca --from-file=ca.crt=global-bundle.pem
    key: ca.crt
```

## Backing up the in-cluster database

Two independent layers; use both.

1. **Volume snapshot** of the PVC `kubeast-postgres-data` (the chart keeps it on
   uninstall, `postgresql.persistence.resourcePolicy: keep`). On EKS: AWS Backup
   plan on the EBS volume (tag-based selection, daily, retention per your
   policy). Restores create a *new* volume in the AZ you choose.
2. **Logical dump** with the server's own `pg_dump` (same major version, custom
   format so `pg_restore` can restore selectively):

   ```bash
   kubectl -n <ns> exec deploy/postgres -c postgres -- pg_dump -Fc -U kubeast kubeast > kubeast-$(date -u +%Y%m%dT%H%M%SZ).dump
   ```

   The dump is a consistent snapshot taken at the start; the services keep
   running. Store it outside the cluster (S3 with object lock / versioning).

## Restoring

### From a logical dump (rehearsed)

Works into a fresh install: the chart's migrations create the empty schema and
the dump replaces it.

```bash
NS=<ns>
# 1. stop everything that writes (the migration Job, if any, has already run)
for d in auth-service session-service k8s-service ai-service model-config-controller-go; do
  kubectl -n $NS scale deploy/$d --replicas=0
done
# 2. restore over the freshly migrated schema
POD=$(kubectl -n $NS get pod -l app=postgres -o name | head -1)
kubectl -n $NS exec -i $POD -c postgres -- pg_restore --clean --if-exists --no-owner -U kubeast -d kubeast < kubeast-<stamp>.dump
# 3. start the services; auth-service sees goose_db_version at the required version and applies nothing
for d in auth-service session-service k8s-service ai-service model-config-controller-go; do
  kubectl -n $NS scale deploy/$d --replicas=1
done
```

Check that:

- admin login works with the password from **before** the loss (it is in the
  dump, hashed);
- `auth_users` / `auth_audit_logs` / `clusters` counts match the source;
- `GET /api/v1/clusters` lists the registrations;
- the schema version table shows the same versions as before.

If the dump is from an **older** Kubeast (lower `goose_db_version`), restore
it and then restart auth-service once: it applies the missing migrations at
boot (`MIGRATIONS_MODE=startup`) or the hook Job does on the next upgrade.

### From a volume snapshot

1. Restore the snapshot to a new volume (AWS Backup → "Restore to EBS volume",
   same AZ as the node group that runs postgres).
2. Create a PV pointing at it and a PVC bound to that PV in the release
   namespace.
3. Point the chart at it and upgrade:

   ```yaml
   postgresql:
     persistence:
       existingClaim: kubeast-postgres-restored
   ```

   The chart stops rendering its own PVC and mounts yours. The data directory
   is a complete PostgreSQL cluster, so no `pg_restore` is needed; the server
   starts from it. Do the same login / count checks.

## Upgrading the PostgreSQL major version

A PostgreSQL server does not start on a data directory from another major
version ("database files are incompatible with server"), so changing
`images.postgres` to a new major needs the data moved once. Move it to a new
volume and keep the old one for a rollback (rehearsed 15 → 18):

```bash
NS=<ns>
# 1. dump with the running server
kubectl -n $NS exec deploy/postgres -c postgres -- pg_dump -Fc -U kubeast kubeast > kubeast-before-upgrade.dump
# 2. a new claim (size and StorageClass as the current one)
kubectl -n $NS apply -f - <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata: {name: kubeast-postgres-data-new}
spec: {accessModes: [ReadWriteOnce], resources: {requests: {storage: 5Gi}}}
EOF
# 3. upgrade onto it with the new image: the new server initializes the empty volume
helm upgrade kubeast <chart> -n $NS --reset-then-reuse-values \
  --set images.postgres=<new image> --set postgresql.persistence.existingClaim=kubeast-postgres-data-new
# 4. restore as in "From a logical dump" above: stop the writers, pg_restore --clean, start them
```

Do the same checks.

- **Rollback**: the old image with the old claim
  (`postgresql.persistence.existingClaim`), untouched. The old claim stays
  until you delete it.
- **docker-compose**: dump the same way (`docker compose exec postgres
  pg_dump …`), move the `postgres_data` volume aside, start the new image on a new
  one, and restore with `docker compose exec -T postgres pg_restore --clean
  --if-exists --no-owner -U kubeast -d kubeast < kubeast-before-upgrade.dump`.

## Retention

Off by default: nothing is deleted unless you set a window. auth-service (the
schema owner) purges once at boot and then every 24 hours, in batches of 5000
rows, and records every run as the audit action `admin.retention.purge`
(actor `system`, with the windows, cutoffs and deleted counts in `after`).
PostgreSQL's autovacuum reuses the freed space; the files do not shrink.

| values | env | deletes |
|---|---|---|
| `retention.auditDays` | `RETENTION_AUDIT_DAYS` | `auth_audit_logs` rows older than N days. The stdout copy of each record (see `audit.stdout`) stays in your log pipeline under its own retention, so the database is not the only copy. With `audit.sinks`, rows a sink has not sent yet are kept until it has. Finished session recordings (`session_recordings`, and their parts with the `database` store) older than N days go too, so they leave the console list; recordings in S3 or files stay until the store's own lifecycle removes them. |
| `retention.chatDays` | `RETENTION_CHAT_DAYS` | AI chat sessions whose last activity (`sessions.updated_at`) is older than N days, with their messages and contexts, and tool approval requests older than N days (their decisions are already audit records). |

Example — access-log retention of one year and six months for chat:

```yaml
retention:
  auditDays: 365
  chatDays: 180
```

Pick the audit window from your regulatory baseline (for example, Korea's
personal-information safety standard requires access records to be kept for
at least one year, two years for some processors). With more than one
auth-service replica, every replica runs the purge. The deletes are idempotent,
so the only effect is one audit record per replica per day.
