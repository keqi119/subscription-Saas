# Stage 10D-C2-B Fadada Real-Name Integration Test

Stage 10D-C2-B validates the real-name lifecycle integration boundary introduced by Stage 10D-C2.

This is a local mocked integration validation. It does not enable production real-name verification, does not call Fadada, and does not create or open a signing URL.

## Scope

Validated path:

```text
registered provider account
-> get_person_verify_url mocked
-> verify callback mocked
-> realNameStatus state machine
-> apply_cert mocked
-> REGISTERED + VERIFIED binding usable by Fadada signer resolver
```

Out of scope:

```text
production Fadada API call
production DB write
contract upload
sign URL generation
manual signing
Contract / Order advancement
PaymentRecord / PaymentWriteOff
ReceivableBill mutation
production deploy
```

## Real-Name Flow Validation

Result: passed.

The account service tests validate:

- `FADADA_REALNAME_VERIFY_ENABLED=false` blocks real-name provider calls;
- `get_person_verify_url` can move a registered binding to `PENDING`;
- request-only PII fields are not stored in the binding snapshot;
- the returned verification URL is masked;
- verified callbacks update `realNameStatus=VERIFIED`;
- duplicate verified callbacks are idempotent;
- invalid callback digest returns `handled=false` / `UNVERIFIED` and does not update account state;
- `find_personCertInfo` refresh can update the binding to `VERIFIED`;
- `apply_cert` is callable only after `VERIFIED` and stores a sanitized provider snapshot.

## State Machine Validation

Result: passed.

Covered transitions:

```text
UNVERIFIED -> PENDING
PENDING -> VERIFIED
PENDING -> FAILED
PENDING -> EXPIRED
VERIFIED -> VERIFIED
```

Terminal rule:

```text
VERIFIED cannot be downgraded by later failed or expired callbacks.
```

## Resolver And Signing Readiness

Result: passed.

The Fadada signer resolver path validates:

- `REGISTERED + VERIFIED` binding is queried before smoke override;
- the formal binding provider customer id is used when present;
- smoke override is used only in non-production when `FADADA_FULL_SIGNING_SMOKE=1` and the local customer matches the allowlisted test customer;
- with smoke disabled, missing or unverified binding fails before PDF artifact lookup, upload, or sign URL request.

This confirms signing readiness:

```text
realNameStatus=VERIFIED -> eligible for Fadada createSignTask resolver
realNameStatus!=VERIFIED -> rejected unless explicit smoke gate is enabled
```

## Callback Correctness

Result: passed.

The real-name verify callback:

- verifies digest before account lookup;
- finds account by verification transaction / serial number;
- updates only `CustomerESignProviderAccount`;
- does not call signing code;
- does not query or advance Contract / Order;
- does not create payment records;
- is idempotent.

## Safety Boundary

No real external or production side effects were performed:

```text
Fadada real API calls: no
uploadDocs: no
extsign_validation: no
extsign_auto: no
signUrl generated/opened: no
signing: no
Contract / Order advancement: no
PaymentRecord / PaymentWriteOff: no
ReceivableBill mutation: no
production DB write: no
production deploy: no
production migration / seed: no
```

No PII, app secret, full provider customer id, full verification URL, provider raw response, or PDF binary is recorded in this report.

## Gate Result

Stage 10D-C2-B result:

```text
Controlled real-name integration boundary: passed
Signing readiness with VERIFIED binding: passed
Smoke override still gated: yes
Production smoke fallback: hard rejected
Unrestricted production e-sign launch: No-Go
```

The next stage can be:

```text
Stage 10D-C2-C production readiness for real-name system
```

or, with separate approval:

```text
Controlled production real-name verification test for one tester
```

## Stage 2 Field eSign Integration Addendum

The field-orchestrated Stage 2 delivery-handover workflow extends the verified
Fadada account boundary without changing Stage 1 selection. It uses exactly
one typed customer H1 transaction followed by one typed platform H2
transaction:

```text
STAGE2_DELIVERY_HANDOVER / DELIVERY_HANDOVER
H1 = STAGE2_HANDOVER_CUSTOMER / CUSTOMER_MANUAL_SIGN
H2 = STAGE2_HANDOVER_PLATFORM / PLATFORM_AUTO_SEAL
```

Provider status `3000` for the exact active H1 is reconciled before H2 is
sealed. Both signed slots are required before the signed PDF can archive.
Provider-completed work cannot be voided or reissued.

After both signed slots complete, pending or failed signed-PDF archive does not
block authorized Admin delivery confirmation. Archive remains visible,
retryable, and independently auditable. Field is the normal initiation path;
Admin fallback initiation is accepted only when the backend revalidates that
the assigned Field identity is technically unavailable, or no task exists 15
minutes after the current bound source PDF `FileObject.createdAt`. The
reserved `Contract.createdAt` does not start the timer, and the database-time
deadline does not depend on SMS success. The Admin must hold
`DELIVERY_CONFIRM`, acknowledge the exact source version/hash, provide a
bounded reason, and the API must revalidate eligibility and append one audit
event in the task-creation transaction.

The rollout defaults and business SMS mapping are:

```dotenv
STAGE2_HANDOVER_WORKFLOW_ENABLED=false
STAGE2_HANDOVER_WORKER_ENABLED=false
STAGE2_HANDOVER_WORKER_CONCURRENCY=1
STAGE2_HANDOVER_WORKER_POLL_INTERVAL_MS=5000
STAGE2_HANDOVER_WORKER_LEASE_MS=120000
ALIYUN_SMS_FIELD_HANDOVER_ESIGN_READY_TEMPLATE_CODE=SMS_510815118
ALIYUN_SMS_CUSTOMER_HANDOVER_ESIGN_READY_TEMPLATE_CODE=SMS_510795093
```

The template codes are non-secret configuration. Business template parameters
remain generic and carry no name, phone, order, vehicle, provider transaction,
or signing URL data.

The focused local gate is:

```bash
pnpm stage2-handover-workflow:backfill:test
pnpm --filter @subscription-saas/api test -- \
  stage2-handover-workflow-recovery.spec.ts stage2-handover-e2e.spec.ts
pnpm prisma:validate
pnpm prisma:generate
```

The complete gate additionally runs recursive lint, typecheck, test, and build.
Staging operations then follow
`docs/stage2-field-esign-rollout-runbook.md`: deploy merged compatible images
with both flags false, run the bundled Prisma CLI directly, prove backfill
convergence, enable workflow, and enable worker last at concurrency `1`.

Rollback always disables `STAGE2_HANDOVER_WORKER_ENABLED` first and never
deletes queued jobs. Human deployment starts only after pull-request merge.
