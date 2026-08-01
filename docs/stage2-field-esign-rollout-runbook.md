# Stage 2 Field eSign Rollout Runbook

This runbook is for human operations after the Stage 2 field-orchestrated
eSign pull request is merged. Do not deploy an unmerged branch or run these
steps from a developer worktree.

## Change Boundary

The rollout enables the durable Stage 2 delivery-handover workflow:

```text
confirmed field review
-> source PDF
-> field initiation
-> customer H1 signature
-> provider status 3000
-> platform H2 seal
-> signing complete
   -> signed PDF archive (automatic retry)
   -> Admin delivery confirmation
```

Stage 1 contract signing remains unchanged. Recovery must use the existing
Admin Web controls and `DELIVERY_CONFIRM` permission. Never void or reissue a
Stage 2 task after provider completion.

Signed-PDF archive is operationally required and remains automatically
retryable, but it is not a hard delivery-confirmation gate after both Stage 2
signers complete. A pending or failed archive must remain visible as a warning.
Field is the normal initiation path. Admin fallback initiation is allowed only
when the authoritative API reports that the assigned Field initiator is
unavailable.

## Required Configuration

Prepare these non-secret values, but keep the worker disabled until the
migration, compatible images, and dry-run have all passed:

```dotenv
PORTAL_SMS_ENABLED=true
PORTAL_SMS_PROVIDER=aliyun
FIELD_OPERATOR_SMS_ENABLED=true
FIELD_OPERATOR_SMS_PROVIDER=aliyun
STAGE2_HANDOVER_WORKFLOW_ENABLED=true
STAGE2_HANDOVER_WORKER_ENABLED=false
STAGE2_HANDOVER_WORKER_CONCURRENCY=1
STAGE2_HANDOVER_WORKER_POLL_INTERVAL_MS=5000
STAGE2_HANDOVER_WORKER_LEASE_MS=120000
ALIYUN_SMS_FIELD_HANDOVER_ASSIGNED_TEMPLATE_CODE=SMS_511185078
ALIYUN_SMS_FIELD_HANDOVER_ESIGN_READY_TEMPLATE_CODE=SMS_510815118
ALIYUN_SMS_CUSTOMER_HANDOVER_ESIGN_READY_TEMPLATE_CODE=SMS_510795093
```

The three SMS template codes are configuration values, not secrets. The
assignment template `SMS_511185078` receives exactly `{ name: Vehicle.plateNo }`.
The Field-ready template `SMS_510815118` and customer-ready template
`SMS_510795093` receive `{}`. Never include names, phones, order data, provider
transaction data, or signing URLs beyond that approved plate variable. Keep
the existing environment-specific Aliyun credentials, Fadada settings, public
URLs, object-storage settings, and platform identity settings out of rollout
records.

## Preconditions

- The pull request is merged and both image tags were built from that merged
  commit.
- A database backup and the previous compatible API/Web image tags are
  recorded in the private operations record.
- PostgreSQL, object storage, Aliyun SMS, Fadada, and API/Web health checks are
  healthy.
- The operator has access to an Admin account with `DELIVERY_CONFIRM`.
- The merged release checkout is the current directory and contains all five
  release-matched files required by the entrypoint and its static imports:
  `scripts/stage2-handover-workflow-backfill.mjs`,
  `scripts/stage2-handover-workflow-backfill-executor.mjs`,
  `scripts/stage2-handover-workflow-backfill-apply.mjs`,
  `scripts/stage2-handover-workflow-backfill-core.mjs`, and
  `scripts/stage2-handover-workflow-contract.mjs`.
- Backfill reports are stored in the restricted operations directory. They
  may contain counts and local IDs only.

Set the Compose file used by the Staging host:

```bash
export COMPOSE_FILE=docker-compose.staging.images.example.yml
export ENV_FILE=.env.staging.images
```

## Staging Rollout

1. Record the current API/Web image values and the SHA-256 checksum of the
   active environment file. Create a timestamped backup under the Staging
   deployment backup directory. Verify `PORTAL_SMS_ENABLED=true` remains
   present. Set only `STAGE2_HANDOVER_WORKER_ENABLED=false`, recreate the
   current API service, and confirm health before changing images or schema.

2. Pull the compatible API image, then apply the additive migration with the
   Prisma binary included in that release image while the worker remains off.
   This is the release image's `prisma migrate deploy` step:

   ```bash
   docker compose -p subauto-staging --env-file "$ENV_FILE" -f "$COMPOSE_FILE" pull api
   docker compose -p subauto-staging --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm --no-deps \
     --workdir /app/apps/api --entrypoint /app/apps/api/node_modules/.bin/prisma api \
     migrate deploy --schema prisma/schema.prisma
   ```

   Do not run `pnpm install`, `pnpm exec`, or any dependency installation in
   the runtime container.

3. Deploy the compatible API/Web images with
   `STAGE2_HANDOVER_WORKER_ENABLED=false`. Confirm API, Admin Web, and Customer
   Web health, image digests, and migration status before proceeding.

4. Bind-mount only the five release-matched backfill scripts read-only and run
   and retain the dry-run report:

   ```bash
   docker compose -p subauto-staging --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm --no-deps \
     --volume "$PWD/scripts:/app/scripts:ro" \
     --entrypoint node api \
     /app/scripts/stage2-handover-workflow-backfill.mjs --dry-run \
     | tee "stage2-backfill-dry-run-$(date -u +%Y%m%dT%H%M%SZ).json"
   ```

   Review only the reported counts, exception codes, and local IDs. Resolve
   every exception before enabling the workflow. This Wave 1 rollout is
   dry-run only: do not use `--apply`, do not update queue rows directly, and
   do not modify SMS logs. It must not downgrade a v2 artifact to v1 or insert
   a retroactive assignment notification. In particular, an invalid
   internal-user mobile is an exception and must never be replaced from a
   legacy production field.

5. Set `STAGE2_HANDOVER_WORKER_ENABLED=true` and keep
   `STAGE2_HANDOVER_WORKER_CONCURRENCY=1`.
   Recreate the API service again and confirm its health:

   ```bash
   docker compose -p subauto-staging --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --no-deps --force-recreate api
   docker compose -p subauto-staging --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps api
   ```

6. In Admin Web, open current acceptance order `ORD20260731173351SMF2` and
   work order `69952e92-4a86-445d-9663-d8692716ec37`. Do not backfill or send
   `SMS_511185078` for its historical assignment. Preserve its existing
   `NOTIFY_FIELD_ESIGN_READY` job and original idempotency key; allow that job
   to recover naturally and send `SMS_510815118` at most once. Only permit
   `SMS_510795093` after a natural Field eSign initiation creates the customer
   signing milestone.

7. Verify the user-configured public-account `/field/handover` entry is
   reachable and shows only authorized tasks. This is verification-only.
   Do not change the WeChat public-account menu during this rollout; do not
   update or reapply it.

8. Confirm the provider status `3000` result advances only H1 to signed,
   creates the H2 platform-seal path, completes H2, and archives the signed
   PDF. Record status names, counts, and local IDs only. Do not retain provider
   request/response bodies, URLs, tokens, evidence URLs, payloads, digests, or
   customer and vehicle details.

9. Execute one new internal-operator handover and one new external-operator
   handover end to end. Confirm both canonical operator snapshots are present,
   each task has exactly the typed H1/H2 signer pair, notifications are
   idempotent, provider completion is reconciled, and the signed PDF archives.
   Only the new natural external assignment may exercise `SMS_511185078`;
   confirm its `name` variable equals that work order's authoritative full
   plate number. A superseded queued assignment must complete without
   contacting the former recipient.

10. In a controlled signed task, hold or fail archive completion. Confirm
    authorized Admin delivery confirmation remains available, the archive
    warning/retry remains visible, and archive recovery continues.

11. Confirm Admin fallback initiation is absent for an available Field
    initiator before 15 minutes from the current source PDF
    `FileObject.createdAt`. Confirm it appears at 15 minutes when no task
    exists, even when the reserved `Contract.createdAt` is older. In a
    controlled exception, make the assigned Field identity technically
    unavailable and confirm the action appears immediately.

12. Confirm Admin must preview and acknowledge the exact source PDF version and
    hash, provide a bounded reason, and that concurrent Field/Admin initiation
    creates one task and one fallback audit event.

13. Keep the worker enabled only after all acceptance checks pass. If any
    acceptance check fails, begin rollback by disabling the worker flag first.
    Never delete queued jobs.

## Admin Recovery

Use the bounded Admin Web actions, which call:

```text
POST /api/handover-work-orders/:id/workflow-jobs/:jobId/retry
POST /api/handover-work-orders/:id/workflow/reconcile-customer
```

Dead-letter retry accepts only the exact `DEAD_LETTER` job for that work
order. It creates one fresh pending replacement with a deterministic recovery
key and copies only the payload fields required by that job type. Manual
customer reconciliation accepts only the exact active typed Stage 2 H1
transaction. Both operations are audited and safe to repeat.

The Admin fallback signing action is separate from dead-letter retry. It must
be used only when `canAdminInitiate=true`; the API rechecks Field
unavailability or the database-time 15-minute no-progress deadline in the same
transaction that creates the Stage 2 task. The timer starts at the current
bound source PDF `FileObject.createdAt`, not the reserved
`Contract.createdAt`, and does not wait for SMS delivery. The action requires
exact source version/hash acknowledgement and a bounded reason. It is not a
normal alternative to Field initiation. Field and Admin starts also rerun the
complete readiness check with that transaction after locking; a stale
preflight result must not create a task.

Do not paste access tokens, response bodies, old error text, signing URLs, or
raw payloads into tickets or rollout records.

## Verification

Before image publication, run from the merged release checkout:

```bash
pnpm stage2-handover-workflow:backfill:test
pnpm --filter @subscription-saas/api test -- \
  stage2-handover-workflow-recovery.spec.ts stage2-handover-e2e.spec.ts
pnpm prisma:validate
pnpm prisma:generate
pnpm -r lint
pnpm -r typecheck
pnpm -r test
pnpm -r build
git diff --check
```

After rollout, verify API health, bounded workflow projections, dead-letter
counts, and archive completion through Admin Web. Do not use unrestricted SQL
or provider dashboards to export business records into the rollout report.

## Rollback

1. Set `STAGE2_HANDOVER_WORKER_ENABLED=false` and recreate the API service.
   Confirm the worker has stopped claiming jobs.
2. Leave every pending, processing, completed, and dead-letter row intact.
   Never delete or bulk-cancel queued jobs.
3. Set `STAGE2_HANDOVER_WORKFLOW_ENABLED=false` and recreate the API service.
   This stops new Stage 2 orchestration while preserving existing data.
4. If runtime rollback is required, restore the previously recorded compatible
   API/Web images. The Stage 2 migration is additive; do not drop its columns,
   enums, indexes, or workflow-job table.
5. Record counts and local IDs for unfinished work. Resume only after the
   defect is fixed, reviewed, merged, and the backfill dry-run again reports
   a safe convergent plan.
