# Production Go / No-Go Record

This record is filled by a human approver immediately before production cutover.
Do not mark `GO` until all production decisions, rollback ownership, and the
cutover window are confirmed.

## Decision

```text
Decision: GO
```

This GO decision is conditional on using the Stage 9F-F0 production image tag
recorded below. The old `d3cdc5e` Web image is blocked for production because it
contains `staging-api.subauto.keybox.cloud`.

| Field | Value |
| --- | --- |
| Decision time | `2026-06-15 22:12:29 +08:00` |
| Approver | `keqi119` |
| Executor | `keqi119` |
| Rollback owner | `keqi119` |
| Cutover window | 60 minutes |
| Acceptable downtime window | 60 minutes |
| Production server | `139.196.227.195` |
| Production Web domain | `admin.subauto.keybox.cloud` |
| Production API domain | `api.subauto.keybox.cloud` |
| Production Git commit | `5e8d04a` for the rebuilt production API/Web images |
| RC tag | `rc-20260613-stage9` |
| API image tag | `ghcr.io/keqi119/subscription-api:prod-20260615-5e8d04a` |
| API image digest | `ghcr.io/keqi119/subscription-api@sha256:af3908801186ddd2ca7cbbf69029bddd7613d77d4061173011ce6276603f9eb9` |
| Web image tag | `ghcr.io/keqi119/subscription-web:prod-20260615-5e8d04a` |
| Web image digest | `ghcr.io/keqi119/subscription-web@sha256:ad0db73e9d8ad3ba72ec6524d716f2b9e39546691d302bc7951d5dcec696b9c3` |
| Production DB strategy | New `production_postgres_data` volume, `migrate deploy`, baseline seed |
| Production OSS strategy | Independent production bucket, `OSS_PREFIX=subscription-saas/production` |
| Production DNS status | Set `admin` / `api` A records to `139.196.227.195` during cutover; TTL 600 |
| Production HTTPS status | Configure via BT/Nginx during cutover |
| Production admin strategy | Rotate default `admin` password immediately after cutover |
| Production smoke account strategy | Create production-only smoke account, do not reuse staging smoke credentials |

## Required Pre-Execution Confirmations

| Confirmation | Status | Notes |
| --- | --- | --- |
| `docs/production-cutover-approval.md` reviewed | Approved | Required before execution |
| `docs/production-cutover-plan.md` reviewed | Approved | Required before execution |
| `docs/production-cutover-checklist.md` reviewed | Approved | Required before execution |
| Immutable production image tags recorded | Approved | `prod-20260615-5e8d04a`; `latest` is forbidden |
| Production database strategy approved | Approved | New `production_postgres_data` volume |
| Production OSS bucket/prefix approved | Approved | Independent production bucket, `subscription-saas/production` prefix |
| Production env prepared on server only | Approved for execution | Do not commit real env; create or verify on the server |
| Pre-cutover backup completed | Approved for execution | Record path and size in the execution report |
| Rollback owner confirmed | Approved | `keqi119` |
| Cutover executor confirmed | Approved | `keqi119` |
| Cutover window confirmed | Approved | 60 minutes |
| DNS TTL prepared | Approved | `600` |
| Production HTTPS plan confirmed | Approved | BT/Nginx and Let's Encrypt |
| Default admin password rotation plan confirmed | Approved | Must change immediately after first login |
| Production smoke command confirmed | Approved | `pnpm smoke:api` with production URLs |

## Backup Record

| Field | Value |
| --- | --- |
| Backup required | Yes |
| Backup file path | `/opt/subscription-saas/backups/staging-before-production-cutover-YYYYMMDDHHmmss.sql` |
| Backup size | Pending execution |
| Backup timestamp | Pending execution |
| Backup source database | `subscription_saas_staging` |
| Restore owner | `keqi119` |
| Restore command reviewed | Yes; restore only from backup, no `migrate reset` / `db push` |

## Open Blockers

```text
None known after Stage 9F-F0. Stop cutover if image pull, Web bundle inspection,
server env preparation, staging backup, production compose, migration, seed,
HTTPS, health, CORS, or production smoke fails. The old d3cdc5e Web image remains
blocked for production.
```

## Accepted Risks

```text
Single-stack cutover is accepted for the 2C / 2G server. The first production
release has no previous production image tag; rollback stops production compose,
restores the last safe backup if needed, and reverts/removes production DNS or
serves a maintenance page.
```

## Deferred Items

The following deferred items are accepted as non-blockers only if the approver
keeps them in this record:

- 8.5C batch valuation approval pass;
- real AI / ML training;
- automated crawler;
- real payment;
- deep e-signature integration;
- SMS / WeChat notifications;
- batch automatic price adjustment;
- advanced capital pool ROE;
- repair work order system.

## Final Notes

```text
GO approval was provided by keqi119 for Stage 9F-F Production Cutover Execution.
Stage 9F-F0 replaced the blocked d3cdc5e Web image with prod-20260615-5e8d04a.
No real secrets, passwords, OSS AccessKeys, or production env contents are
recorded in this file.
```
