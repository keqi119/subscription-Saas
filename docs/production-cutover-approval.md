# Stage 9F-E Production Cutover Approval

This document is the Go / No-Go approval gate before production cutover execution.
It does not execute production cutover, switch DNS, start production compose,
run production migrations, run production seed, or connect to a production database.

Current decision:

```text
GO / NO-GO: GO
```

## 1. Approval Information

| Field | Value |
| --- | --- |
| Approval name | Stage 9F-E Production Cutover Approval |
| Approval date | `2026-06-15 22:12:29 +08:00` |
| Approver | `keqi119` |
| Executor | `keqi119` |
| Rollback owner | `keqi119` |
| Target environment | production |
| Target server | `139.196.227.195` |
| Server size | `2 CPU / 2 GB RAM / 40 GB disk` |
| Production Web domain | `admin.subauto.keybox.cloud` |
| Production API domain | `api.subauto.keybox.cloud` |
| Approval baseline commit | `0bb470d1c146f642c0fac15fb582dcd421e54555` |
| Target production commit | `d3cdc5e` for the validated API/Web images |
| Target API image tag | `ghcr.io/keqi119/subscription-api:d3cdc5e` |
| Target Web image tag | `ghcr.io/keqi119/subscription-web:d3cdc5e` |
| Target RC tag | `rc-20260613-stage9` |
| Includes migration | Yes; `prisma migrate deploy` only |
| Needs production seed | Yes; baseline seed only |
| Needs scenario seed | No by default; requires explicit approval |
| Needs backup | Yes |
| Needs staging stop | Yes; single-stack cutover on the 2 CPU / 2 GB server |
| Recommended cutover strategy | single-stack cutover |

## 2. Staging Gate Conclusion

The staging gate is closed for the current release candidate evidence set.

Validated staging items:

- registry pull deployment;
- healthy API/Web/PostgreSQL containers;
- `migrate deploy`;
- baseline seed;
- OSS upload/download;
- API stream download without public OSS URL exposure;
- public HTTPS;
- CORS preflight;
- `smoke:api`;
- `smoke:mainline`;
- `smoke:residual`;
- Web route smoke;
- backup;
- resource check on the 2 CPU / 2 GB server.

Evidence:

- `docs/staging-dry-run-report.md`
- `docs/object-storage-readiness.md`

Staging-specific accounts such as `stage9_smoke_admin` must not be reused for
production defaults or production smoke credentials.

## 3. Go / No-Go Checklist

| Check | Current status | Evidence | Blocking | Notes |
| --- | --- | --- | --- | --- |
| `main` contains all staging fix commits | Passed | `main` contains `45f9240`, `ab98904`, and `6fbacb4` | No | Verified before this approval branch |
| `release:check` passes | Passed | Stage 9F-E precheck | No | Scenario/smoke substeps remain opt-in |
| Staging public HTTPS passes | Passed | `docs/staging-dry-run-report.md` | No | Stage 9F-C-R3 closed public 80/443 / HTTPS gate |
| Staging OSS validation passes | Passed | `docs/object-storage-readiness.md`; `docs/staging-dry-run-report.md` | No | API reports `storage:"oss"` |
| Production cutover plan completed | Passed | `docs/production-cutover-plan.md` | No | Stage 9F-D completed |
| Production env example completed | Passed | `.env.production.images.example` | No | Real env must remain server-only |
| Production compose example completed | Passed | `docker-compose.production.images.example.yml` | No | Compose config passed in Stage 9F-D |
| Production Nginx example completed | Passed | `nginx/production-subauto.example.conf` | No | BT/Nginx owns 80/443 |
| Backup / restore plan completed | Passed | `docs/backup-restore.md`; `docs/production-cutover-plan.md` | No | Actual backup path is pending |
| Manual acceptance completed | Passed for staging / production pending after cutover | `docs/manual-acceptance.md`; staging reports | No for execution | Production acceptance must run after cutover |
| Release blockers | No known pre-execution blocker after approval | `docs/release-candidate-report.md`; this document | No | Stop if execution checks fail |
| Deferred items confirmed | Passed | Section 5 | No | Deferred items are not cutover blockers |
| Production image tag confirmed | Approved | Go / No-Go record | No | `d3cdc5e`, not `latest` |
| Production image digest confirmed | Pending execution registry inspection | Go / No-Go record | No if registry cannot provide digest, but must be attempted | Prefer digest evidence |
| Production OSS prefix confirmed | Approved | `.env.production.images` on server | No | Independent bucket and `subscription-saas/production` prefix |
| Production DB strategy confirmed | Approved | Go / No-Go record | No | New `production_postgres_data` volume |
| Production admin strategy confirmed | Approved | Go / No-Go record | No | Default admin password must change immediately |
| Rollback owner confirmed | Approved | Go / No-Go record | No | `keqi119` |
| Cutover window confirmed | Approved | Go / No-Go record | No | 60 minutes |

## 4. Production Cutover Decisions

### 4.1 Single-Stack Cutover

Recommended decision:

```text
Yes
```

Reason: the current `2 CPU / 2 GB RAM` server is not suitable for long-running
staging and production dual-stack operation.

Approval value:

```text
Yes
```

### 4.2 Stop Staging Before Production

Decision required:

```text
Yes / No
```

Approval value:

```text
Yes
```

### 4.3 Production Database Strategy

Options:

```text
A. Create a new production_postgres_data volume.
B. Reuse staging database and rename/switch environment.
C. Use managed PostgreSQL.
```

Recommended decision:

```text
A. Create a new production_postgres_data volume.
```

Reason: staging contains validation data and should not become the production
initial dataset by default.

Approval value:

```text
A. Create a new production_postgres_data volume.
```

### 4.4 Production OSS Strategy

Options:

```text
A. Same bucket, separate prefix: subscription-saas/production
B. Independent production bucket
```

Either option is acceptable only if production is isolated from staging.

Required confirmations:

- `OSS_PREFIX=subscription-saas/production` or an isolated production bucket;
- bucket private;
- RAM policy covers the production prefix or bucket;
- API streams downloads and does not expose permanent public OSS URLs.

Approval value:

```text
Independent production bucket with OSS_PREFIX=subscription-saas/production.
```

### 4.5 Production Image Tag

Requirements:

- do not use `latest`;
- use fixed immutable tags;
- record `API_IMAGE`;
- record `WEB_IMAGE`;
- record image digests if available.

Approval value:

```text
API_IMAGE=ghcr.io/keqi119/subscription-api:d3cdc5e
WEB_IMAGE=ghcr.io/keqi119/subscription-web:d3cdc5e
Image digests must be recorded during Stage 9F-F execution.
```

### 4.6 Production Admin Strategy

Required confirmations:

- default `admin` password is changed immediately after first login;
- decide whether to create a production-only smoke account;
- decide whether to disable all staging smoke accounts;
- decide whether to delete `stage9_smoke_admin`.

Approval value:

```text
Rotate the default admin password immediately after production smoke. Create a
production-only smoke account and do not reuse staging smoke credentials.
```

### 4.7 Production DNS And HTTPS Strategy

Production DNS records:

| Host | Type | Value |
| --- | --- | --- |
| `admin.subauto.keybox.cloud` | `A` | `139.196.227.195` |
| `api.subauto.keybox.cloud` | `A` | `139.196.227.195` |

Required confirmations:

- TTL is `600` or lower where supported;
- certificate issuance method is confirmed;
- HTTPS verification method is confirmed;
- HTTP redirects to HTTPS;
- CORS allows `https://admin.subauto.keybox.cloud`.

Approval value:

```text
Set both production A records to 139.196.227.195 during the cutover window with
TTL 600, then configure and verify BT/Nginx HTTPS.
```

### 4.8 Rollback Strategy

Required confirmations:

- previous API image tag;
- previous Web image tag;
- database backup path;
- rollback owner;
- rollback window;
- rollback smoke command and operator.

Approval value:

```text
Rollback owner is keqi119. This is the first production cutover, so there is no
previous production image tag. If cutover fails, stop production compose, restore
from backup if database changes require it, and revert/remove production DNS or
serve a maintenance page.
```

## 5. Deferred Items

The following items are deferred and are not production cutover blockers for the
current back-office release:

- 8.5C batch valuation approval pass;
- real AI / ML training;
- automated crawler;
- real payment;
- deep e-signature integration;
- SMS / WeChat notifications;
- batch automatic price adjustment;
- advanced capital pool ROE;
- repair work order system.

## 6. Approval Outcome

Current outcome:

```text
Decision: GO
Can enter Stage 9F-F Production Cutover Execution: Yes
```

The human approver filled `docs/production-go-no-go-record.md` for Stage 9F-F.
No real secrets, passwords, OSS AccessKeys, or production env contents are
recorded in this file.
