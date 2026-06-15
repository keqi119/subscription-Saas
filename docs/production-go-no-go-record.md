# Production Go / No-Go Record

This record is filled by a human approver immediately before production cutover.
Do not mark `GO` until all production decisions, rollback ownership, and the
cutover window are confirmed.

## Decision

```text
Decision: Pending
```

| Field | Value |
| --- | --- |
| Decision time | Pending approval |
| Approver | Pending approval |
| Executor | Pending approval |
| Rollback owner | Pending approval |
| Cutover window | Pending approval |
| Acceptable downtime window | Pending approval |
| Production server | `139.196.227.195` |
| Production Web domain | `admin.subauto.keybox.cloud` |
| Production API domain | `api.subauto.keybox.cloud` |
| Production Git commit | Pending approval |
| RC tag | `rc-20260613-stage9` |
| API image tag | Pending approval |
| API image digest | Pending approval |
| Web image tag | Pending approval |
| Web image digest | Pending approval |
| Production DB strategy | Pending approval |
| Production OSS strategy | Pending approval |
| Production DNS status | Pending approval |
| Production HTTPS status | Pending approval |
| Production admin strategy | Pending approval |
| Production smoke account strategy | Pending approval |

## Required Pre-Execution Confirmations

| Confirmation | Status | Notes |
| --- | --- | --- |
| `docs/production-cutover-approval.md` reviewed | Pending approval | Required before execution |
| `docs/production-cutover-plan.md` reviewed | Pending approval | Required before execution |
| `docs/production-cutover-checklist.md` reviewed | Pending approval | Required before execution |
| Immutable production image tags recorded | Pending approval | `latest` is forbidden |
| Production database strategy approved | Pending approval | Recommended: new `production_postgres_data` volume |
| Production OSS bucket/prefix approved | Pending approval | Must be isolated from staging |
| Production env prepared on server only | Pending approval | Do not commit real env |
| Pre-cutover backup completed | Pending approval | Record path and size below |
| Rollback owner confirmed | Pending approval | Required before execution |
| Cutover executor confirmed | Pending approval | Required before execution |
| Cutover window confirmed | Pending approval | Required before execution |
| DNS TTL prepared | Pending approval | Recommended `600` or lower where supported |
| Production HTTPS plan confirmed | Pending approval | BT/Nginx or equivalent |
| Default admin password rotation plan confirmed | Pending approval | Must change immediately after first login |
| Production smoke command confirmed | Pending approval | `pnpm smoke:api` with production URLs |

## Backup Record

| Field | Value |
| --- | --- |
| Backup required | Yes |
| Backup file path | Pending approval |
| Backup size | Pending approval |
| Backup timestamp | Pending approval |
| Backup source database | Pending approval |
| Restore owner | Pending approval |
| Restore command reviewed | Pending approval |

## Open Blockers

```text
Pending approval
```

## Accepted Risks

```text
Pending approval
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
Pending approval
```
