# Stage 10D-B5-B-MIGRATION-APPLY Production No-Seed Migrate Deploy

> Date: 2026-06-28
> Branch: `feature/stage10-fadada-production-upload-signurl-smoke-run`
> PR: #123, Draft
> Scope: production DB no-seed migration apply only.

## 1. Scope And Approval

The user explicitly approved Stage 10D-B5-B-MIGRATION-APPLY with these limits:

- allowed: fresh production DB backup;
- allowed: production `prisma migrate deploy`;
- allowed: production migrate status and health checks;
- forbidden: production seed, `db push`, `migrate reset`;
- forbidden: API candidate deployment, Web restart, Fadada API calls, sign URL opening, signing, task creation, contract/order advancement, payment/write-off/bill mutation.

No production seed, API deployment, Fadada call, signing action, task creation, contract/order advancement, payment posting, write-off, or bill mutation was executed.

## 2. Pre-Apply State

| Field | Result |
| --- | --- |
| production DB | `subscription_saas_prod` |
| production API image before apply | `ghcr.io/keqi119/subscription-api:portal-rc-r6-20260620-4188aec` |
| production API health before apply | healthy |
| migration source | `ghcr.io/keqi119/subscription-api:fadada-pr123-20260627-214576b` |
| migration source count | 54 migrations |
| pending migrations | 14 |
| preflight clone deploy | success |
| production migrate deploy authorized | yes |

Migration source note:

```text
The migration source image contains all 54 migration directories.
It is valid for migrate deploy, but it was built from 214576b and does not contain H1 application code.
Future API candidate redeploy must rebuild from df4d33d or later.
```

## 3. Fresh Pre-Apply Backup

| Field | Result |
| --- | --- |
| backup path | `/opt/subscription-saas/backups/subscription_saas_prod_20260628150152_pre_migrate_apply.dump` |
| size | 641582 bytes |
| sha256 | `e0c20c0e1143c3f098bbb2f11dc5de03cb93fefd9c9851bfe09793fd77a3bcdb` |
| `pg_restore -l` | success |

No database URL, password, secret, customer PII, or backup content was printed or committed.

## 4. Production Migrate Deploy

Command class:

```text
prisma migrate deploy --schema prisma/schema.prisma
```

Execution source:

```text
one-off container from ghcr.io/keqi119/subscription-api:fadada-pr123-20260627-214576b
```

Result:

| Field | Result |
| --- | --- |
| production migrate deploy executed | yes |
| seed executed | no |
| `db push` executed | no |
| `migrate reset` executed | no |
| start | `2026-06-28T07:02:40Z` |
| DB apply range | `2026-06-28 15:02:48+08` to `2026-06-28 15:02:49+08` |
| DB apply duration | 1 second |
| command wall time | about 12 seconds |
| result | success |

Applied migrations:

```text
20260620100000_portal_sms_send_logs
20260621100000_vehicle_listing_profiles
20260621110000_vehicle_condition_reports
20260622160000_customer_profile_materials
20260622190000_vehicle_insurance_documents_claims
20260622210000_vehicle_baas_contracts
20260623090000_vehicle_depreciation_policies
20260623170000_vehicle_model_codes
20260624090000_vehicle_model_definitions
20260624110000_vehicle_model_definition_on_vehicle
20260624123000_product_model_definition_links
20260624170000_residual_model_definition_links
20260624193000_quote_order_model_snapshots
20260624203000_quote_order_model_code_snapshots
```

## 5. Production Migrate Status

Post-apply read-only status:

```text
54 migrations found in prisma/migrations
Database schema is up to date
```

Sanity counts:

```text
_prisma_migrations=54
customers=6
subscription_orders=1
contract_esign_tasks=0
```

Counts are for sanity only. No rows or PII were printed.

## 6. Production API Health

The production API was not redeployed in this stage. It remains on the previous rollback image:

```text
ghcr.io/keqi119/subscription-api:portal-rc-r6-20260620-4188aec
```

Post-migration checks:

| Check | Result |
| --- | --- |
| API container status | running |
| API container health | healthy |
| public `/api/health` | HTTP 200, `status:"ok"`, `storage:"oss"` |
| log tail | no migration-related crash observed |

## 7. Rollback Position

Rollback was not needed.

Rollback plan remains:

1. Prefer API rollback if a later candidate image has application-level issues.
2. DB restore should be reserved for data damage or unusable schema.
3. DB restore would use the fresh pre-apply backup and requires a maintenance window.
4. Because these migrations are mostly additive, the current DB schema is expected to remain forward-compatible with the old API until candidate redeploy.

## 8. Local Quality Verification

Local verification after documentation updates:

```text
pnpm release:check
PASS release check
```

The release check used isolated local PostgreSQL:

```text
127.0.0.1:55432/subscription_saas
```

No production seed was executed.

## 9. Current Gate

Production migration apply gate:

```text
passed
```

Next allowed stage:

```text
Stage 10D-B5-B-ENV-B: rebuild H1 API candidate + API-only deploy + callback readiness probe
```

Still forbidden:

```text
B5-B full signing execution
```

B5-B execution can only be reconsidered after:

1. rebuild API candidate from `df4d33d` or later;
2. deploy API-only with Fadada runtime env;
3. API health passes;
4. callback invalid digest probe returns non-500 and does not advance business state;
5. target customer mapping and Fadada runtime masked checks pass.
