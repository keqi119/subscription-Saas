# Stage 10D-B5-B-MIGRATION-PREFLIGHT Production DB Pending Migrations

> Date: 2026-06-28
> Branch: `feature/stage10-fadada-production-upload-signurl-smoke-run`
> PR: #123, Draft
> Scope: production DB pending migration impact review and isolated clone rehearsal only.

## 1. Scope And Safety Boundary

This stage did not run production `migrate deploy`, production seed, `db push`, `migrate reset`, API deployment, Fadada API calls, sign URL opening, signing, task creation, contract/order advancement, payment posting, write-off, or bill mutation.

Allowed operations performed:

- read-only production migration status;
- production `pg_dump -Fc` backup;
- backup list validation with `pg_restore -l`;
- restore into an isolated PostgreSQL clone;
- `prisma migrate deploy` on the isolated clone;
- temporary candidate API probe against the isolated clone.

## 2. H1 / Branch Status

| Check | Result |
| --- | --- |
| local branch | `feature/stage10-fadada-production-upload-signurl-smoke-run` |
| local HEAD | `df4d33d7bbc9d612b9f685b94ca05934c9bd4f91` |
| H1 commit | `df4d33d fix: reject invalid fadada callbacks before business lookup` |
| origin branch HEAD | `df4d33d7bbc9d612b9f685b94ca05934c9bd4f91` |
| PR #123 contains H1 | yes, after push |

Important image note:

```text
Existing candidate image ghcr.io/keqi119/subscription-api:fadada-pr123-20260627-214576b
was built from source commit 214576b and does not include H1.
```

Before any future production API candidate redeploy, build a new image from `df4d33d` or later.

## 3. Production Migration Status

Read-only status was run from the PR #123 candidate image against production DB.

| Field | Result |
| --- | --- |
| DB identifier | `subscription_saas_prod` on internal `postgres:5432` |
| total migrations in PR #123 schema | 54 |
| applied production migrations | 40 |
| pending production migrations | 14 |
| production migrate deploy executed | no |
| production seed executed | no |

Pending migrations:

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

## 4. Migration Impact Matrix

| Migration | Operation type | Nullable columns | Non-null columns | Enum | Table | Index | Constraint | Data migration | Lock risk | Current API compatible | Candidate dependency | Risk | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `20260620100000_portal_sms_send_logs` | create SMS log enums/table/indexes | no | new table only | yes | yes | yes | no FK | no | low | yes | medium | Additive portal SMS audit table. |
| `20260621100000_vehicle_listing_profiles` | create listing profile/media/plan enums/tables/indexes/FKs | no | new table only | yes | yes | yes | yes | no | low | yes | medium | Additive portal listing schema. |
| `20260621110000_vehicle_condition_reports` | create condition report enums/tables/indexes/FKs | no | new table only | yes | yes | yes | yes | no | low | yes | medium | Additive vehicle condition report schema. |
| `20260622160000_customer_profile_materials` | create customer material enums/table/index/FK | no | new table only | yes | yes | yes | yes | no | low | yes | medium | Additive customer profile material table. |
| `20260622190000_vehicle_insurance_documents_claims` | create insurance/document/claim enums/tables/indexes/FKs | no | new table only | yes | yes | yes | yes | no | low | yes | medium | Adds claim FK to existing order/customer tables but no existing table rewrite. |
| `20260622210000_vehicle_baas_contracts` | create BaaS contract/attachment/cost enums/tables/indexes/FKs | no | new table only | yes | yes | yes | yes | no | low | yes | medium | Additive BaaS accounting support tables. |
| `20260623090000_vehicle_depreciation_policies` | create depreciation enums/tables/indexes/FKs | no | new table only | yes | yes | yes | yes | no | low | yes | medium | Additive depreciation support tables; references existing `vehicle_depreciation_method`. |
| `20260623170000_vehicle_model_codes` | add enum values to `vehicle_model` | no | no | alter enum | no | no | no | no | low | mostly yes | medium | Existing API remains safe unless new enum values are written before old code understands them. |
| `20260624090000_vehicle_model_definitions` | create model definition table/indexes | no | new table only | no | yes | yes | no FK | no | low | yes | high | Foundation for candidate model-definition code paths. |
| `20260624110000_vehicle_model_definition_on_vehicle` | add nullable FK to `vehicle` | yes | no | no | no | yes | yes | no | medium | yes | high | Adds `vehicle.model_definition_id`; index/FK may briefly lock `vehicle`. |
| `20260624123000_product_model_definition_links` | add nullable FKs to product tables | yes | no | no | no | yes | yes | no | medium | yes | high | Adds model definition links to `vehicle_package` and `product_price_rule`. |
| `20260624170000_residual_model_definition_links` | add nullable FKs to residual/market tables | yes | no | no | no | yes | yes | no | medium | yes | high | Adds model definition links to residual market/curve/forecast/run tables. |
| `20260624193000_quote_order_model_snapshots` | add nullable snapshot columns to quote/order | yes | no | no | no | no | no | no | medium | yes | high | Directly provides missing `subscription_order.model_definition_id_snapshot` from ENV-A. |
| `20260624203000_quote_order_model_code_snapshots` | add nullable code snapshot columns to quote/order | yes | no | no | no | no | no | no | medium | yes | high | Candidate quote/order/report serializers reference these snapshots. |

Summary:

- No pending migration contains `UPDATE`, `INSERT`, `DELETE`, backfill, seed, or irreversible data rewrite statements.
- Most migrations are additive.
- The highest practical risk is operational lock time on existing tables during `ALTER TABLE`, `CREATE INDEX`, and FK validation.
- The direct ENV-A blocker is addressed by `20260624193000_quote_order_model_snapshots`.

## 5. Production Backup

Existing backup before this stage was not recent enough:

```text
/opt/subscription-saas/backups/subscription_saas_prod_20260620140248.dump
```

After manual approval, a new production backup was created.

| Field | Result |
| --- | --- |
| backup path | `/opt/subscription-saas/backups/subscription_saas_prod_20260628142508.dump` |
| size | 641582 bytes |
| sha256 | `00ca6f0e1aef1d68cd13e20680166830432f05c51d3bfbeca3f9b814782d94d8` |
| `pg_restore -l` | success |

No database URL, password, secret, customer PII, or backup content was printed or committed.

## 6. Isolated Clone Restore

The new backup was restored into an isolated temporary PostgreSQL container.

| Field | Result |
| --- | --- |
| clone container | `subauto-migration-preflight-20260628142508-postgres` |
| clone DB | `subscription_saas_prod_clone` |
| restore result | success |
| tables sanity count | 80 |
| `_prisma_migrations` before deploy | 40 |
| customers count | 6 |
| subscription orders count | 1 |
| e-sign tasks count | 0 |

Counts are for sanity only. No rows or PII were printed.

## 7. Clone Migrate Deploy

`prisma migrate deploy` was run only against the isolated clone.

| Field | Result |
| --- | --- |
| applied migrations | 14 |
| duration | 5 seconds |
| deploy result | success |
| clone migrate status | database schema is up to date |
| `_prisma_migrations` after deploy | 54 |

All 14 pending migrations applied successfully on the clone.

## 8. Candidate API Compatibility On Clone

A temporary API container was started against the clone DB only. It did not replace production API and was bound only to server localhost.

| Check | Result |
| --- | --- |
| image used | `ghcr.io/keqi119/subscription-api:fadada-pr123-20260627-214576b` |
| image source | `214576b`, before H1 |
| API health | success |
| health body | `status:"ok"`, `storage:"oss"` |
| invalid digest callback | HTTP `201` |
| invalid digest body | `{"handled":false,"reason":"UNVERIFIED"}` |
| clone probe task count | 0 |
| clone probe signer count | 0 |
| clone probe callback log count | 1 |

Interpretation:

- The migrated clone schema is compatible with the existing PR #123 candidate image for API boot and invalid-digest callback probing.
- Because the image used here predates H1, this check does not prove that the rebuilt H1 image has been deployed.
- The next production candidate image must be rebuilt from `df4d33d` or later before redeploy.

## 9. Seed Policy

Production migration apply should be:

```text
prisma migrate deploy only
no production seed
```

Seed remains a separate approval item. No production seed was executed in this preflight.

Clone rehearsal seed: not executed.

## 10. Local Quality Verification

Local verification passed after the migration preflight docs were added:

```text
pnpm release:check
PASS release check
```

The release check used isolated local PostgreSQL:

```text
127.0.0.1:55432/subscription_saas
```

No production seed was executed.

## 11. Rollback / Restore Plan

1. Run `pg_dump -Fc` immediately before production migration apply.
2. PostgreSQL migrations in this repo do not include down scripts.
3. DB rollback is primarily restore from backup, not migration down.
4. DB restore requires a maintenance window and application downtime.
5. API image rollback can be done independently through the compose image env and `docker compose up -d --no-deps api`.
6. DB restore and API rollback must be matched to a compatible schema/code pair.
7. If migration succeeds but the new API has an app issue, prefer API rollback first because these migrations are mostly additive and forward-compatible.
8. Restore DB backup only if migration damages data or leaves schema unusable.

## 12. Recommendation

| Question | Recommendation |
| --- | --- |
| Apply pending migrations to production? | Yes, after explicit production migration apply approval and a fresh backup at apply time. |
| Use no-seed migrate deploy? | Yes. |
| Need maintenance window? | Recommended, because several existing tables receive columns/indexes/FKs and rollback requires restore. |
| Must H1 be pushed first? | Done. H1 is on origin at `df4d33d`. |
| Can rebuild PR #123 candidate image? | Yes, next candidate must use `df4d33d` or later. |
| Can redeploy candidate API now? | Not until production migration apply is explicitly approved and completed. |
| Can rerun invalid digest probe? | Yes, after production migration apply and rebuilt candidate API deployment. |
| Can enter B5-B execution? | No. |

Production migration apply gate:

```text
ready for human approval discussion: yes
approved to execute production migrate deploy in preflight stage: no
executed later in Stage 10D-B5-B-MIGRATION-APPLY: yes
```

B5-B execution remains blocked until:

1. production migration apply is explicitly approved and succeeds;
2. a new API candidate image is built from `df4d33d` or later;
3. production API candidate + Fadada runtime env deployment succeeds;
4. production callback invalid digest probe returns non-500 and does not advance business state.

## 13. Follow-Up Migration Apply

Stage 10D-B5-B-MIGRATION-APPLY is recorded in `docs/stage-10d-fadada-production-migration-apply.md`.

Production `prisma migrate deploy` was later approved and completed successfully with no seed. Production migrate status is now up to date with 54 migrations.
