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

Deploy the compatible API and Web images with these values first:

```dotenv
STAGE2_HANDOVER_WORKFLOW_ENABLED=false
STAGE2_HANDOVER_WORKER_ENABLED=false
STAGE2_HANDOVER_WORKER_CONCURRENCY=1
STAGE2_HANDOVER_WORKER_POLL_INTERVAL_MS=5000
STAGE2_HANDOVER_WORKER_LEASE_MS=120000
ALIYUN_SMS_FIELD_HANDOVER_ESIGN_READY_TEMPLATE_CODE=SMS_510815118
ALIYUN_SMS_CUSTOMER_HANDOVER_ESIGN_READY_TEMPLATE_CODE=SMS_510795093
```

The two SMS template codes are configuration values, not secrets. Their
`instruction` parameter must remain generic and must not contain names,
phones, order data, provider transaction data, or signing URLs. Keep the
existing environment-specific Aliyun credentials, Fadada settings, public
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
- The merged release checkout is the current directory and contains the three
  `scripts/stage2-handover-workflow-backfill*` files.
- Backfill reports are stored in the restricted operations directory. They
  may contain counts and local IDs only.

Set the Compose file used by the Staging host:

```bash
export COMPOSE_FILE=docker-compose.staging.images.yml
```

## Staging Rollout

1. Deploy compatible API and Web images with both Stage 2 flags set to
   `false`. Confirm API, Admin Web, and Customer Web health before proceeding.

2. Apply migrations with the Prisma binary already included in the runtime
   image:

   ```bash
   docker compose -f "$COMPOSE_FILE" exec -T \
     --workdir /app/apps/api api \
     /app/apps/api/node_modules/.bin/prisma migrate deploy \
     --schema prisma/schema.prisma
   ```

   Do not run `pnpm install`, `pnpm exec`, or any dependency installation in
   the runtime container.

3. Run and retain the dry-run report:

   ```bash
   docker compose -f "$COMPOSE_FILE" run --rm --no-deps \
     --volume "$PWD/scripts:/app/scripts:ro" \
     --entrypoint node api \
     /app/scripts/stage2-handover-workflow-backfill.mjs --dry-run \
     | tee "stage2-backfill-dry-run-$(date -u +%Y%m%dT%H%M%SZ).json"
   ```

   Review only the reported counts, exception codes, and local IDs. Resolve
   every exception before enabling the workflow. In particular, an invalid
   internal-user mobile is an exception and must never be replaced from a
   legacy production field.

4. Apply once, then repeat dry-run:

   ```bash
   docker compose -f "$COMPOSE_FILE" run --rm --no-deps \
     --volume "$PWD/scripts:/app/scripts:ro" \
     --entrypoint node api \
     /app/scripts/stage2-handover-workflow-backfill.mjs --apply \
     | tee "stage2-backfill-apply-$(date -u +%Y%m%dT%H%M%SZ).json"

   docker compose -f "$COMPOSE_FILE" run --rm --no-deps \
     --volume "$PWD/scripts:/app/scripts:ro" \
     --entrypoint node api \
     /app/scripts/stage2-handover-workflow-backfill.mjs --dry-run \
     | tee "stage2-backfill-convergence-$(date -u +%Y%m%dT%H%M%SZ).json"
   ```

   The repeated dry-run must report zero operator snapshot updates and zero
   new job candidates. Repeated apply must also remain converged.

5. Set `STAGE2_HANDOVER_WORKFLOW_ENABLED=true` while keeping
   `STAGE2_HANDOVER_WORKER_ENABLED=false`, then recreate only the API service:

   ```bash
   docker compose -f "$COMPOSE_FILE" up -d --no-deps --force-recreate api
   ```

6. Set `STAGE2_HANDOVER_WORKER_ENABLED=true` and keep concurrency at `1`.
   Recreate the API service again and confirm its health:

   ```bash
   docker compose -f "$COMPOSE_FILE" up -d --no-deps --force-recreate api
   docker compose -f "$COMPOSE_FILE" ps api
   ```

7. In Admin Web, open order `ORD20260726073922TFHF`. Confirm its exact active
   typed Stage 2 H1 transaction receives a
   `RECONCILE_CUSTOMER_SIGNATURE` workflow job. The bounded workflow history
   may show it as pending, processing, or completed; it must not bind to a
   Stage 1 task.

8. Confirm the provider status `3000` result advances only H1 to signed,
   creates the H2 platform-seal path, completes H2, and archives the signed
   PDF. Record status names, counts, and local IDs only. Do not retain provider
   request/response bodies, URLs, tokens, evidence URLs, payloads, digests, or
   customer and vehicle details.

9. Execute one new internal-operator handover and one new external-operator
   handover end to end. Confirm both canonical operator snapshots are present,
   each task has exactly the typed H1/H2 signer pair, notifications are
   idempotent, provider completion is reconciled, and the signed PDF archives.

10. In a controlled signed task, hold or fail archive completion. Confirm
    authorized Admin delivery confirmation remains available, the archive
    warning/retry remains visible, and archive recovery continues.

11. Confirm Admin fallback initiation is absent while the Field initiator is
    available. In a controlled exception, make the assigned Field initiator
    unavailable and confirm the backend exposes one audited fallback action to
    an Admin with `DELIVERY_CONFIRM`.

12. Keep the worker enabled only after all acceptance checks pass. If any
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
unavailability before creating the Stage 2 task. It is not a normal alternative
to Field initiation.

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
