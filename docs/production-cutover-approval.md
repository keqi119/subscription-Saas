# Stage 9F-E Production Cutover Approval

This document is the Go / No-Go approval gate before production cutover execution.
It does not execute production cutover, switch DNS, start production compose,
run production migrations, run production seed, or connect to a production database.

Current decision:

```text
GO / NO-GO: Pending
```

## 1. Approval Information

| Field | Value |
| --- | --- |
| Approval name | Stage 9F-E Production Cutover Approval |
| Approval date | Pending approval |
| Approver | Pending approval |
| Executor | Pending approval |
| Rollback owner | Pending approval |
| Target environment | production |
| Target server | `139.196.227.195` |
| Server size | `2 CPU / 2 GB RAM / 40 GB disk` |
| Production Web domain | `admin.subauto.keybox.cloud` |
| Production API domain | `api.subauto.keybox.cloud` |
| Approval baseline commit | `0bb470d1c146f642c0fac15fb582dcd421e54555` |
| Target production commit | Pending approval |
| Target API image tag | Pending approval |
| Target Web image tag | Pending approval |
| Target RC tag | `rc-20260613-stage9` |
| Includes migration | Pending approval |
| Needs production seed | Pending approval |
| Needs scenario seed | No by default; requires explicit approval |
| Needs backup | Yes |
| Needs staging stop | Pending approval |
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
| Manual acceptance completed | Passed for staging / Pending for production | `docs/manual-acceptance.md`; staging reports | Yes for production cutover | Production acceptance must run after cutover |
| Release blockers | No known code blocker / Pending approval items remain | `docs/release-candidate-report.md`; this document | Yes if approval items remain pending | Do not execute while decision is Pending |
| Deferred items confirmed | Passed | Section 5 | No | Deferred items are not cutover blockers |
| Production image tag confirmed | Pending approval | To be recorded in Go / No-Go record | Yes | Must not use `latest` |
| Production image digest confirmed | Pending approval | To be recorded in Go / No-Go record | No if registry cannot provide digest, but must be attempted | Prefer digest evidence |
| Production OSS prefix confirmed | Pending approval | `.env.production.images` on server | Yes | Must be isolated from staging |
| Production DB strategy confirmed | Pending approval | Go / No-Go record | Yes | Recommended: new `production_postgres_data` volume |
| Production admin strategy confirmed | Pending approval | Go / No-Go record | Yes | Default admin password must change immediately |
| Rollback owner confirmed | Pending approval | Go / No-Go record | Yes | Required before execution |
| Cutover window confirmed | Pending approval | Go / No-Go record | Yes | Include downtime window |

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
Pending approval
```

### 4.2 Stop Staging Before Production

Decision required:

```text
Yes / No
```

Approval value:

```text
Pending approval
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
Pending approval
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
Pending approval
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
Pending approval
```

### 4.6 Production Admin Strategy

Required confirmations:

- default `admin` password is changed immediately after first login;
- decide whether to create a production-only smoke account;
- decide whether to disable all staging smoke accounts;
- decide whether to delete `stage9_smoke_admin`.

Approval value:

```text
Pending approval
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
Pending approval
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
Pending approval
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
Decision: Pending
Can enter Stage 9F-F Production Cutover Execution: No
```

The decision can become `GO` only after a human approver fills
`docs/production-go-no-go-record.md` and confirms all required production
decisions.
