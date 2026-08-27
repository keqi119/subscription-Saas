# Stage 1 Active-Term Contract Change Release Runbook

This runbook releases the four governed Active-order change types: extension, vehicle swap,
early termination, and managed-other. It contains no credentials and does not authorize a
production rollout.

## 1. Independent rollout flags

All flags are fail-closed and accept only the exact lowercase value `true`:

```text
SUBSCRIPTION_EXTENSION_ENABLED
SUBSCRIPTION_VEHICLE_SWAP_ENABLED
SUBSCRIPTION_EARLY_TERMINATION_ENABLED
SUBSCRIPTION_MANAGED_OTHER_ENABLED
```

Staging must explicitly set `SUBSCRIPTION_EXTENSION_ENABLED=true`. The Stage 1 four-type smoke
requires all four Staging flags to be `true`. Production examples keep all four flags `false`
until a separate rollout decision is approved.

## 2. Required release order

1. Back up the target database and record the API/Web image identifiers.
2. Deploy migrations and verify Prisma migration status/checksums.
3. Start the new API/Web images with the approved Staging flag values.
4. Run the contract-change bootstrap in dry-run mode.
5. Review every exception row. Do not infer or fabricate missing business facts.
6. Run apply mode only against the confirmed target database.
7. Run dry-run again. Deterministic candidate counts must be zero; unresolved exception rows
   remain manual-repair blockers.
8. Run the four-type automated Staging smoke before opening manual acceptance.

## 3. Bootstrap commands

Use a dedicated test database first:

```bash
pnpm stage1:contract-change:bootstrap:test
pnpm stage1:contract-change:bootstrap:dry-run
pnpm stage1:contract-change:bootstrap:apply
pnpm stage1:contract-change:bootstrap:dry-run
```

The script audits only non-deleted `ACTIVE` subscription orders. It reports:

- missing deterministic `BASE` contract segments;
- missing, multiple, malformed, or vehicle-mismatched open subscription periods;
- multiple active V2 contract changes for one order;
- extension roots that still lack typed extension detail facts;
- invalid or non-explicit rollout flag values.

Apply mode writes only deterministic `BASE` segments and typed extension details. It does not
modify an order root, repair vehicle periods, select a winning active change, invent dates,
or guess missing commercial facts. Re-running apply is idempotent.

Exit code `2` means the report contains flag blockers or manual-repair exceptions. Exit code `1`
means the script itself failed. A dry-run never opens a write transaction.

## 4. Staging preflight evidence

Capture redacted evidence for:

- database host/database name and migration head (never the password);
- four resolved boolean flag states;
- first dry-run report;
- apply report with created/existing counts;
- second dry-run report proving zero remaining deterministic candidates;
- API/Web image identifiers and health checks;
- four-type smoke results.

Do not proceed to manual acceptance while any order has multiple active changes, an invalid open
vehicle period, or an incomplete extension-detail source.

## 5. Rollback

Set the affected type flag to `false` and restart the API. Do not delete change orders, quotes,
contracts, vehicle reservations, periods, Closure cases, automation jobs, or audit facts. Existing
manual-takeover and reconciliation evidence must remain available for controlled recovery.
