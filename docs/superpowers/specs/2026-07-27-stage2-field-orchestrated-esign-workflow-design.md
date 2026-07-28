# Stage 2 Field-Orchestrated eSign Workflow Design

## Decision

Stage 2 vehicle handover signing will use a database-backed durable workflow:

```text
Portal customer confirmation
  -> automatic source PDF generation
  -> field operator notification
  -> field operator PDF review and eSign initiation
  -> customer SMS and Portal notification
  -> customer Fadada signing
  -> automatic platform seal
  -> signing complete
     -> automatic signed-PDF archive (asynchronous, non-blocking)
     -> Admin delivery confirmation
```

The normal path does not require Admin to generate the PDF, create the eSign
task, start the platform seal, or archive the signed PDF. Admin handles only
delivery confirmation and exhausted workflow exceptions. If the backend
confirms that the assigned Field initiator is unavailable, an authorized Admin
may use the audited fallback initiation action to keep the handover moving.

This design supersedes the narrower provider-status reconciliation design
committed as `3272646`.

## Confirmed Product Requirements

- Internal and external field operators are registered in Admin with a name
  and mobile number.
- Both operator types log in to the same Field application with mobile OTP.
- Both operator types have the same handover permissions and use the same
  eSign action in the same Field task page.
- Customer confirmation returns immediately while PDF generation continues
  asynchronously.
- The field operator receives an SMS after the source PDF is ready.
- The field operator must review the generated PDF and confirm that it matches
  the physical handover before starting eSign.
- The customer receives an SMS and a Portal notification after the field
  operator starts eSign.
- Platform sealing and signed-PDF archive happen automatically.
- Once both required signers are complete, a pending or failed signed-PDF
  archive is shown as a warning/retry state and does not block authorized Admin
  delivery confirmation.
- Admin fallback initiation is available immediately when the assigned Field
  initiator is technically unavailable, or after 15 minutes without a Stage 2
  task from the current bound source PDF `FileObject.createdAt`. This file
  timestamp is the authoritative PDF-finalization time; the earlier reserved
  `Contract.createdAt` is not a timer anchor. The timeout is based on database
  time and is not delayed by SMS delivery or retry state.
- Admin fallback requires `DELIVERY_CONFIRM`, an exact source PDF
  version/hash acknowledgement, and a bounded reason. It is recorded as
  `ADMIN_FALLBACK`; it never impersonates the Field operator.
- Field and Admin initiation both rerun the complete Stage 2 readiness check
  with the same database transaction after the work-order/handover lock is
  acquired. A preflight result cannot authorize task creation after customer
  objection, work-order, evidence, identity-readiness, or source state changes.
- Provider and callback failures receive bounded automatic recovery before
  entering an Admin exception queue.

## Scope

### Included

- Canonical field operator identity snapshot and unified Field OTP access.
- Durable Stage 2 workflow jobs using PostgreSQL.
- Automatic source PDF generation after customer confirmation.
- Field PDF preview, review acknowledgement, and eSign initiation.
- Field and customer business notifications.
- Stage 2-specific Portal signing entry.
- Fadada status query, expired-entry refresh, callback reconciliation,
  automatic platform seal, and signed-PDF archive.
- Admin workflow timeline and exception actions.
- Existing active Stage 2 task backfill.

### Excluded

- Stage 1 behavior changes.
- Redis, BullMQ, or a managed queue.
- Automatic delivery confirmation.
- Lease, billing, payment, or accounting state changes before Admin delivery
  confirmation.
- SMS containing Field tokens, Fadada URLs, evidence URLs, or personal data.
- A generic workflow platform for unrelated modules.

## Happy Path

### 1. Customer Confirmation

`POST /api/portal/handover-reviews/:id/confirm` continues to validate:

- current customer ownership;
- current review attempt;
- field fact completeness;
- evidence completeness;
- exact current evidence manifest hash;
- no active objection.

The confirmation transaction writes the existing customer-confirmed facts and
inserts one `GENERATE_SOURCE_PDF` workflow job using an idempotency key derived
from the work order, review attempt, and manifest hash.

The request does not render the PDF. Portal returns a workflow projection with
`PDF_PENDING` and displays "交接确认单生成中".

### 2. Automatic Source PDF

The worker calls an idempotent `ensureStage2HandoverPdf` operation. It reuses
the approved renderer and preserves all current PDF requirements:

- current customer confirmation and evidence snapshot;
- complete photo attachments at four photos per page;
- video list and key frames;
- evidence hashes and protected evidence reference;
- full customer information required by the handover agreement;
- full VIN;
- full field operator phone in the signature section;
- exactly one customer and one platform signing coordinate;
- the 15 MiB generation target, 18 MiB internal hard limit, and Fadada
  document-size limit.

If the source artifact already exists and still matches the manifest and
source hash, the operation returns it instead of creating another Contract,
FileObject, or object-storage file.

On success, the worker inserts `NOTIFY_FIELD_ESIGN_READY`.

### 3. Field Operator Review And Initiation

The assigned task remains visible in Field after customer confirmation. Field
facts and evidence become read-only, while the PDF and workflow status become
visible.

The Field task page provides:

- PDF preview;
- PDF download;
- source document number, generation time, size, and hash summary;
- notification status;
- "发起电子签".

The action opens a confirmation dialog requiring the operator to affirm that
the PDF matches the physical handover. The request includes the displayed
artifact version and source hash.

The Field endpoint:

```text
POST /api/field/handover/work-orders/:id/esign
```

uses Field OTP authentication, verifies the canonical assigned phone, reloads
all source bindings, records the review acknowledgement, and creates the typed
Stage 2 eSign task. Repeated requests return the same active task.

On success, the worker inserts `NOTIFY_CUSTOMER_ESIGN_READY` and
`RECONCILE_CUSTOMER_SIGNATURE`.

### 4. Customer Signing

The customer SMS and Portal notification both direct the customer to:

```text
/portal/handover-reviews/:workOrderId
```

The dedicated Stage 2 endpoint returns the customer signing entry. Stage 2
handover contracts shown in the generic contract list link back to the handover
review page and never invoke the Stage 1 contract signing path.

If the local entry URL expires:

- query the exact Fadada customer transaction;
- return an already-signed projection when Fadada reports `3000`;
- otherwise issue a new signed entry for the same provider contract,
  customer, transaction, and signing coordinate;
- never re-upload the PDF or create another transaction.

### 5. Platform Seal And Archive

A verified customer completion callback, or an equivalent provider query
result, marks only the customer signer signed and inserts
`AUTO_SEAL_PLATFORM` in the same transaction.

The callback returns HTTP 200 after the durable job is written. It does not
wait for the platform provider call.

The worker uses the deterministic Stage 2 platform transaction suffix `H2`.
It follows the proven Stage 1 auto-seal mapping while adding durable retry and
status reconciliation. Successful platform sealing inserts
`ARCHIVE_SIGNED_PDF`.

Archive downloads the final provider PDF, validates it, calculates SHA-256,
stores it under the deterministic signed-artifact identity, and updates the
handover archive pointer. Archive remains automatic and retryable, but it is
not a delivery-confirmation gate after both required signers are complete.

## Durable Workflow

### Data Model

Add Stage 2-specific enums:

```text
VehicleHandoverWorkflowJobType
  GENERATE_SOURCE_PDF
  NOTIFY_FIELD_ESIGN_READY
  NOTIFY_CUSTOMER_ESIGN_READY
  RECONCILE_CUSTOMER_SIGNATURE
  AUTO_SEAL_PLATFORM
  RECONCILE_PLATFORM_SEAL
  ARCHIVE_SIGNED_PDF

VehicleHandoverWorkflowJobStatus
  PENDING
  PROCESSING
  COMPLETED
  DEAD_LETTER
  CANCELLED
```

Add `VehicleHandoverWorkflowJob` with:

- `id`;
- `workOrderId`;
- optional `handoverId` and `eSignTaskId`;
- `jobType`;
- `jobStatus`;
- globally unique `idempotencyKey`;
- `availableAt`;
- `attemptCount`;
- `maxAttempts`;
- `leaseToken` and `leaseExpiresAt`;
- sanitized `payload` and `resultSnapshot`;
- bounded `lastErrorCode` and `lastErrorMessage`;
- `startedAt`, `completedAt`, `createdAt`, and `updatedAt`.

Payloads contain only local IDs, versions, hashes, and provider transaction
identifiers. They contain no mobile OTP, URL digest, full signing URL, provider
secret, or object-storage credential.

### Transactional Enqueue

Every state transition and its next job are committed in one PostgreSQL
transaction. A unique idempotency key makes enqueue idempotent.

Examples:

```text
pdf:<workOrderId>:<reviewAttemptId>:<manifestHash>
field-notify:<workOrderId>:<artifactVersion>
customer-notify:<eSignTaskId>:<customerTransactionId>
customer-reconcile:<eSignTaskId>:<customerTransactionId>
platform-seal:<eSignTaskId>:<platformTransactionId>
archive:<eSignTaskId>:<artifactVersion>
```

### Claim And Lease

The API worker claims due jobs atomically with PostgreSQL row locking and
`SKIP LOCKED`. A claim changes the job to `PROCESSING`, assigns a random lease
token, and sets a bounded lease expiry.

PDF and archive handlers renew their lease while processing. A crashed worker
leaves an expired lease that another instance may reclaim. Business
idempotency remains mandatory even with leasing.

### Retry Policy

Side-effect failures use a default five-attempt schedule:

```text
1 minute -> 5 minutes -> 15 minutes -> 1 hour -> 6 hours
```

After the final failed attempt the job becomes `DEAD_LETTER` and appears in the
Admin exception projection.

An observed provider `SIGNING` state is not a failure and does not consume an
attempt. Customer status checks run around 2, 10, and 30 minutes after
initiation, then every 6 hours while the task remains active. A callback or
successful query cancels obsolete pending checks.

Worker concurrency, poll interval, lease duration, and enablement are
environment-configurable. The implementation uses low default concurrency for
PDF rendering.

## Unified Field Operator Identity

Add canonical nullable migration fields to `VehicleHandoverWorkOrder`:

```text
fieldOperatorName
fieldOperatorPhone
```

Admin assignment writes these snapshots for both operator types:

- internal assignment reads `User.name` and `User.mobile` and rejects users
  without a valid mobile;
- external assignment uses the registered name and mobile form values.

`operatorType` remains an origin classification. It no longer gates Field
access.

Migration backfill uses:

- existing external operator name and phone for external assignments;
- related User name and mobile for internal assignments.

Rows that cannot be backfilled are reported as assignment exceptions and do
not receive Field access or notification until Admin corrects them.

Field OTP task discovery and authorization use normalized
`fieldOperatorPhone`. Internal and external operators receive identical task
DTOs and action permissions. Existing legacy assignment fields are retained
during this phase.

The operator snapshot freezes when customer review begins. Reassignment after
that point is rejected because operator identity is part of the confirmed
facts and PDF. A controlled pre-confirmation reassignment invalidates the
previous review projection as required by existing rules.

## Notifications

Extend the SMS provider with business-template sending instead of reusing OTP
templates.

Add SMS purposes:

```text
FIELD_HANDOVER_ESIGN_READY
CUSTOMER_HANDOVER_ESIGN_READY
```

Add a nullable unique SMS idempotency key so a retried notification job cannot
send the same logical notification twice.

Configure separate Aliyun templates:

```text
ALIYUN_SMS_FIELD_HANDOVER_ESIGN_READY_TEMPLATE_CODE
ALIYUN_SMS_CUSTOMER_HANDOVER_ESIGN_READY_TEMPLATE_CODE
```

Field SMS is a generic instruction to log in to Field. Customer SMS is a
generic instruction to log in to Portal. Neither contains a task token,
provider URL, evidence URL, customer data, or vehicle detail.

Customer notification creates both:

- one SMS send record; and
- one Portal notification pointing to the dedicated handover review.

If one channel succeeds and the other fails, retry processes only the missing
channel. Notification failure does not invalidate a ready PDF or eSign task,
but exhausted failure appears in Admin.

## Fadada Reconciliation

Extend the provider abstraction with an exact signer-status query:

```text
SIGNED | SIGNING | FAILED | UNKNOWN
```

Fadada queries require the locally bound:

- provider contract ID;
- verified provider customer ID;
- signer provider transaction ID.

Only the documented signed result `3000` advances a signer. Unknown or
mismatched values fail closed.

Customer callbacks and customer status queries call one shared Stage 2
transition. Platform auto-seal success, platform callbacks, and platform status
queries call one shared platform transition. The callback log remains callback
evidence; provider queries write workflow result and audit evidence rather
than fabricated callback rows.

Serializable transactions, exact transaction equality, signer slot checks,
and idempotent jobs handle duplicate, delayed, reordered, and concurrent
events.

Before retrying an ambiguous platform operation, the worker queries the
deterministic platform transaction. It sends another provider request only
when completion is not already confirmed.

## UI And Authorization

### Portal

Portal shows:

- customer confirmed;
- PDF generating;
- waiting for field initiation;
- waiting for customer signature;
- platform processing;
- signing complete.

The signing action exists only in the dedicated handover review context.

### Field

Field remains read-only after evidence submission but continues to show the
task. It exposes PDF review and eSign initiation only when:

- the authenticated mobile matches the canonical assignment;
- the current review is customer-confirmed;
- the source PDF exists and matches the current manifest;
- no active eSign task conflict exists;
- customer and platform Fadada readiness gates pass.

### Admin

The normal order view presents one timeline and final delivery confirmation.
Manual PDF, eSign, platform-seal, and archive buttons are absent from the happy
path.

Admin fallback initiation is an exception action, not a second normal signing
path. It is visible only when the authoritative API returns
`canAdminInitiate=true`. The capability is true when the assigned Field
initiator is technically unavailable, or when no Stage 2 task exists 15
minutes after the current bound source PDF `FileObject.createdAt`. The
reserved `Contract.createdAt` must not start this timer. SMS success is not
part of this timer.

The Admin must preview and acknowledge the exact source PDF artifact version
and hash, then enter a bounded reason. The create transaction locks and reloads
the handover, revalidates Field availability or the 15-minute deadline, verifies
that no task/provider action exists, verifies the source binding, creates at
most one task, and appends one bounded audit event. It requires the existing
delivery-confirm permission and records actor type `ADMIN_FALLBACK`.

After a job enters `DEAD_LETTER`, Admin displays only the relevant action:

- retry PDF generation;
- resend field notification;
- resend customer notification;
- reconcile customer status;
- retry platform seal;
- retry signed-PDF archive;
- void and reissue only while provider signing has not completed.

Every Admin recovery action requires the existing delivery-confirm permission
and writes an audit event.

## State And Side-Effect Boundaries

The legal/business progression is:

```text
CUSTOMER_CONFIRMED
  -> SOURCE_GENERATED
  -> PENDING_CUSTOMER_SIGNATURE
  -> PENDING_PLATFORM_SEAL
  -> SIGNED
     -> ARCHIVED
     -> ADMIN_DELIVERY_CONFIRMATION
```

A workflow failure leaves the business entity at the last confirmed state.
Customer confirmation is never rolled back because PDF rendering or SMS fails.
Archive failure after `SIGNED` remains visible and retryable but does not roll
back signing or disable authorized Admin delivery confirmation.

No workflow handler writes:

- `actualDeliveryAt`;
- lease start or end;
- billing schedules or bills;
- payments;
- accounting or depreciation records.

Only the existing authorized Admin delivery-confirm action may advance those
downstream states, and only after Stage 2 signing and all existing non-archive
delivery gates pass.

## Migration And Rollout

### Schema Migration

The migration adds:

1. canonical field operator snapshot columns and indexes;
2. workflow job enums, table, indexes, and uniqueness constraint;
3. SMS purpose values and SMS idempotency key;
4. handover event and Portal notification event values required by the new
   timeline.

No legacy assignment or eSign columns are dropped.

### Backfill

Provide an idempotent command with dry-run and apply modes. It:

- backfills canonical operator snapshots;
- reports incomplete internal user mobile data;
- creates the correct next workflow job for active Stage 2 work orders;
- creates no job for terminal, cancelled, or already archived work.

For `ORD20260726073922TFHF`, the command detects the active typed task and
creates `RECONCILE_CUSTOMER_SIGNATURE`. Fadada `3000` then advances it to
automatic platform seal and archive without repeating customer or Field work.

### Feature Flags

Use separate flags:

```text
STAGE2_HANDOVER_WORKFLOW_ENABLED
STAGE2_HANDOVER_WORKER_ENABLED
```

Rollout order:

1. deploy schema-compatible API and Web images with both flags off;
2. apply migration;
3. run and inspect backfill dry-run;
4. apply backfill;
5. enable workflow API behavior in Staging;
6. enable the worker at low concurrency;
7. verify the existing order recovery;
8. run a new complete Staging handover.

## Observability

Log and expose bounded metrics for:

- jobs queued, claimed, completed, retried, reclaimed, and dead-lettered;
- duration by job type;
- provider status outcomes;
- notification outcomes by channel;
- callback/query reconciliation source;
- PDF and archive bytes and duration;
- active jobs with expired leases.

Logs use local IDs and masked provider identifiers. They never emit signing
URLs, digests, full mobiles, secrets, or evidence URLs.

## Test Strategy

### API And Database

- customer confirmation and PDF enqueue in one transaction;
- job idempotency and concurrent enqueue;
- multi-worker claim, lease renewal, crash reclaim, and dead-letter behavior;
- idempotent PDF creation without duplicate Contract, FileObject, or storage
  object;
- internal and external assignment backfill and unified Field OTP access;
- assignment freeze after customer review starts;
- Field PDF authorization, hash/version mismatch, acknowledgement, and eSign
  idempotency;
- SMS and Portal notification channel idempotency;
- exact Fadada query IDs and `3000`-only acceptance;
- callback/query races and delayed callbacks;
- expired entry refresh with the same transaction and coordinate;
- automatic platform seal query-before-retry;
- signed-PDF archive idempotency;
- delivery confirmation allowed for `SIGNED` while archive is pending or
  failed, with archive warning and retry still visible;
- Admin fallback initiation denied while the Field initiator is available and
  the current source PDF is younger than 15 minutes; allowed immediately for a
  technically unavailable Field initiator or after the 15-minute no-progress
  deadline, only when the backend reports `canAdminInitiate=true`;
- concurrent Field and Admin initiation produces exactly one task;
- late provider failure/rejection observations never downgrade an already
  signed signer, task, or handover;
- void/reissue is denied whenever any exact provider transaction, claim, or
  signed evidence exists, regardless of the local task terminal status;
- delivery, lease, billing, payment, and accounting isolation.

### Web

- Portal asynchronous PDF states and dedicated Stage 2 signing entry;
- Field unified operator flow, read-only evidence, PDF review gate, and eSign
  action;
- Admin happy-path timeline and precise dead-letter actions;
- mobile and desktop layout with no overlapping controls.

### Staging Acceptance

1. Recover `ORD20260726073922TFHF` through provider query, automatic seal, and
   archive.
2. Create a new order and complete the entire confirmed flow.
3. Verify internal and external operator OTP access separately.
4. Verify field and customer notifications.
5. Verify one forced failure and automatic retry for PDF, SMS, platform seal,
   and archive.
6. Verify a signed-but-unarchived handover can be confirmed by an authorized
   Admin while the archive warning/retry remains visible.
7. Verify Admin fallback initiation is absent with an available Field operator
   before 15 minutes, appears after 15 minutes without a task, and appears
   immediately when the assigned Field identity is technically unavailable.
8. Verify Admin fallback requires the exact source version/hash acknowledgement
   and reason, is audited once, and races with Field initiation to one task.
9. Verify late failed/rejected provider observations cannot downgrade signed
   state and any provider transaction/claim/signed evidence blocks
   void/reissue.
10. Confirm delivery remains manual and downstream states do not advance early.

## Stage 1 Review Notes

Stage 1 already proves the customer-callback-to-platform-auto-seal business
sequence. This design reuses that mapping, including deterministic platform
transactions and success-code handling.

Stage 1 currently has reliability gaps that this Stage 2 workflow must not
copy:

- provider auto-seal runs inline before the callback request returns;
- provider calls lack durable retry jobs;
- lost callbacks lack a first-class provider-status compensation path;
- expired customer entry recovery is incomplete;
- ambiguous platform results lack durable query-before-retry handling.

These findings are recorded for a later Stage 1 optimization. This
implementation does not alter Stage 1 runtime behavior.
