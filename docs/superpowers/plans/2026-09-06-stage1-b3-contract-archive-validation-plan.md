# Stage 1 B3 合同、电子签与 PDF 归档独立验证实施计划

> **Status: APPROVED — bounded local validation only.** User-approved content baseline: `51981b32`. Approval does not establish completed validation or authorize production fixes, external services, or release.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Independently validate that an electronic-signature task completion is only a provider-process fact, while Stage 1 platform archive admission requires the persisted `Contract` archive tuple and its actual PDF `FileObject`; duplicate and out-of-order callbacks/signals must converge without creating B4 activation facts.

**Architecture:** Preserve the existing authority split: `ESignService.handleCallback` owns signer/task completion and the `SIGNED` transition; `FadadaSignedArtifactService.archiveSignedContract` validates, stores, hashes, and atomically admits the archived PDF; `SubscriptionJourneyService.dispatchSignalOutbox` advances the signing step only from `FADADA_ARTIFACT_ARCHIVED`. Add one B3-owned PostgreSQL characterization suite that uses the real Prisma-backed services and repository with deterministic in-process provider/storage boundaries. The first pass changes tests, manifest registration, and evidence only; any runtime counterexample stops execution and requires a separately reviewed production amendment.

**Tech Stack:** TypeScript 6, NestJS 11, Prisma 7/PostgreSQL 17, Vitest 4, pnpm 11, the existing release database-suite launcher.

**Spec:** `DEV_SPEC.md`; `docs/superpowers/specs/2026-09-06-stage1-minimal-controlled-release-decision.zh-CN.md`; `docs/superpowers/plans/2026-09-06-stage1-mainline-minimal-release-implementation-plan.md`; `docs/superpowers/specs/2026-09-01-stage1-s0-authority-and-temporary-asset-governance-design.zh-CN.md`; `docs/acceptance/2026-09-06-stage1-mainline-execution-index.md`

## 审批摘要

- 本计划只申请一个 B3 专属 PostgreSQL 测试、数据库测试清单的增量纳管，以及一份本轮新鲜证据；不预授权生产代码修改。
- 电子签任务完成只证明供应商流程事实；平台归档准入需要完整 Contract 归档元组和可解析的 PDF FileObject，且 `ARCHIVED` 不被解释为法律生效时间。
- 不调用真实 Fadada/OSS，不写 Lease/VehicleSubscriptionPeriod，不运行 B4 激活；snapshot 链和真实供应商验证继续留给 R3/A2/A3。
- 用户已单独批准 `51981b32` 的限定本地验证范围。任何生产反例都在精确失败摘要处停止，不在本计划内顺手修复。

## Global Constraints

- Only B3 among these five plans has user implementation approval at `51981b32`; the other four remain subject to their separate revisions/reviews. This status entry is metadata, not a change to B3's scope or proof requirements.
- The planning baseline is `4b93f8abf4697d3970205d3d37e78e8a55b4ebd6`. At implementation time, use the approved descendant and classify every pre-existing change before touching B3-owned files.
- P0/P1 are closed and their controlled targets were retired. The fixed target record and four fixed secret files are absent. Historical P1 run IDs, database identities, digests, and counts are context only and must not be reused as B3 evidence.
- The only B3 database entry is the existing self-provisioning `scripts/release/run-database-suite.mjs --chain fresh`. Do not create a bootstrap, cleanup, credential, target-record, evidence-schema, test context, or suite launcher. Do not use an ambient `DATABASE_URL` or directly invoke the database Vitest project.
- Do not read credential contents or retirement archives. Do not call Fadada, OSS, cloud, GitHub, Staging, production, notification, payment, or other external services. The suite's deterministic adapters must throw if an unplanned provider method is reached.
- `ContractVersion` remains the immutable text/template authority. `ContractESignTask` and `ContractESignSigner` remain provider-process facts. Platform archive admission is the `Contract` tuple `status=ARCHIVED`, non-null `archivedAt`, non-null `fileId`, and a matching, valid PDF `FileObject`; `ARCHIVED` must not be described as legal-effective time.
- The archive path may preserve `signedAt` and order payment state, but B3 must not create/update `Lease`, `VehicleSubscriptionPeriod`, delivery/handover activation, billing schedules, or any B4 fact. `apps/api/src/lease/lease-activation.engine.ts` is read/test-only and B4-owned.
- Do not add schema/models/enums, migrations, RBAC permissions, feature flags, package scripts, shared fixture frameworks, or generic production fixes. Reuse `requiredReleaseDatabaseTestContext`, `insertRuntimeOrderGraph`, and `insertRuntimeContract`; all new B3-specific fixture builders and doubles stay inside the new B3 spec.
- Existing conforming behavior gets characterization evidence, not a fabricated behavioral RED. The only expected RED below is discovery proving that the new database file is unclassified before its exact manifest entry is added.
- If a new assertion exposes a runtime contradiction, stop. Preserve the exact failing test, persisted before/after facts, and source method; propose the smallest exact production edit in a plan amendment, but do not make it under this plan.
- Snapshot-chain execution remains required by manifest policy but belongs to the later R3/A2 controlled snapshot input. B3 runs only the fresh chain and does not claim snapshot or real-provider evidence.

---

## Audited Source and Evidence Boundaries

| Boundary                        | Source evidence at the planning baseline                                                                                                                                                                                                                                                                                                                                                                                          | B3 treatment                                                                                                                                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Contract text and archive facts | `apps/api/prisma/schema.prisma:7976`, `:8005`, and `:8511` separate `ContractVersion`, `Contract`, and `FileObject`. The Contract archive tuple is independent of task completion.                                                                                                                                                                                                                                                | Persist and reread all four admission facts plus PDF MIME, byte count, object identity, and SHA-256. Assert the ContractVersion row is unchanged.                                                                              |
| Callback process                | `ESignService.handleCallback(...)` at `apps/api/src/esign/esign.service.ts:1036`, `handleFadadaCallback(...)` at `:2102`, `findCallbackTask(...)` at `:2311`, and `completeTask(...)` at `:2375` verify/correlate callbacks, make task/signer completion monotonic, set Contract `SIGNED`, and emit the stable task-completed signal. They do not admit the archive or call activation.                                           | Call the real `ESignService` against PostgreSQL with only `ESignProvider.verifyCallback` deterministic. Cover replay, success-then-failure/rejection, and failure/rejection-then-success.                                      |
| Archive admission               | `FadadaSignedArtifactService.archiveSignedContract(...)` at `apps/api/src/esign/fadada/fadada-signed-artifact.service.ts:136` requires a completed Fadada task/all required signers, validates `%PDF`, stores bytes, creates `FileObject`, and transactionally writes the Contract archive tuple and stable archive signal. The existing archive tuple returns before provider/storage calls.                                     | Call the real service with a subclass overriding only `getApiClient()` and a real `StorageService` over an in-memory `StorageProvider`; assert success, rollback/precondition negatives, and duplicate short-circuit counters. |
| Journey admission               | `SubscriptionJourneyService.dispatchSignalOutbox(...)` at `apps/api/src/subscription-journey/subscription-journey.service.ts:168` enqueues reconciliation for `FADADA_TASK_COMPLETED` but calls `completeStep` only for `FADADA_ARTIFACT_ARCHIVED`. `SubscriptionJourneyRepository.recordSignal(...)` at `apps/api/src/subscription-journey/subscription-journey.repository.ts:912` uses a stable event key and versioned outbox. | Dispatch persisted task/archive outboxes in reverse order and replay them through the real service/repository. Prove one step transition and no late reconciliation/backslide.                                                 |
| B4 prerequisite, not B3 write   | `LeaseActivationEngine.readAuthorityFacts(...)` at `apps/api/src/lease/lease-activation.engine.ts:393` and `evaluateFacts(...)` at `:465` require the complete archive tuple plus the referenced FileObject; missing facts yield `CONTRACT_ARCHIVED_ARTIFACT_MISSING`.                                                                                                                                                            | Re-run the existing unit test read-only. In the PG suite query `Lease` and `VehicleSubscriptionPeriod` counts before/after; do not instantiate or call `LeaseActivationEngine`.                                                |
| Existing mock coverage          | `apps/api/test/esign.spec.ts` covers verified/unverified/unknown/mismatched, duplicate, and late callbacks; `fadada-archive.spec.ts` covers PDF/archive success, invalid bytes/storage/finalization failures, and duplicate archive; `subscription-journey-esign.spec.ts` covers the task-vs-archive signal split; `lease-activation.spec.ts:56` rejects `SIGNED` without archive facts.                                          | Re-run unchanged as fast characterization. These in-memory tests are not PostgreSQL proof.                                                                                                                                     |
| Existing PostgreSQL limit       | `subscription-journey-golden-path.e2e-spec.ts:344` directly creates an ESign task and updates Contract to `ARCHIVED`; it does not call `ESignService` or `FadadaSignedArtifactService`. Other Journey PG suites cover repository/integrity/failure recovery, not this service boundary.                                                                                                                                           | Add one narrowly owned real-service PG suite rather than treating the synthetic golden path as B3 proof.                                                                                                                       |
| External-provider limit         | `release/contracts/external-validation-applicability.v1.json` retains `stage1.esign = must-external-verify` because a mock/deterministic provider cannot prove real signing and archive connectivity.                                                                                                                                                                                                                             | Read only. B3 fresh evidence cannot close or downgrade this A3 obligation.                                                                                                                                                     |

## File Ownership and Cross-Package Coordination

| Path                                                                                                                                                                                  | Planned ownership                          | Consumers / coordination                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/test/stage1-contract-archive.integration.spec.ts`                                                                                                                           | **Create — B3 sole owner.**                | A B3-local fixture and deterministic adapters only. Uses existing release test context/runtime-domain helpers; exports nothing and creates no B1/B5 shared helper.                                                                      |
| `release/contracts/database-test-manifest.v1.json`                                                                                                                                    | **Modify — one minimal serialized merge.** | Add `api.stage1-contract-archive.postgres` to `batch-b` and one suite record. Before applying, reread the latest file and preserve every already-integrated B1/B5/R entry; never replace/reformat the whole manifest from a stale copy. |
| `docs/acceptance/2026-09-06-stage1-b3-contract-archive-validation.md`                                                                                                                 | **Create — B3 evidence owner.**            | Records only fresh observed results and limitations. It does not edit the shared mainline execution index or claim candidate promotion.                                                                                                 |
| `apps/api/test/esign.spec.ts`; `fadada-archive.spec.ts`; `subscription-journey-esign.spec.ts`; `lease-activation.spec.ts`                                                             | **Read/Test only.**                        | Existing in-memory callback/archive/journey/activation characterization; no duplicated fixtures or edits.                                                                                                                               |
| `apps/api/test/helpers/release-database-test-context.ts`; `runtime-domain-fixture.ts`                                                                                                 | **Read/Import only.**                      | Existing runtime-equivalent identity and minimal database graph. No new shared fixture API is authorized.                                                                                                                               |
| `apps/api/src/esign/esign.service.ts`; `esign.provider.ts`; `esign.controller.ts`; `fadada/fadada-signed-artifact.service.ts`; `apps/api/src/storage/storage.service.ts`              | **Read only.**                             | Real admin/public callback and archive services/callers. A failing counterexample must name one exact method before seeking separate modification approval.                                                                             |
| `apps/api/src/subscription-journey/subscription-journey.service.ts`; `subscription-journey-signal.service.ts`; `subscription-journey.repository.ts`; `subscription-journey.config.ts` | **Read only.**                             | Shared B1–B6 signal/outbox logic; the test composes the real classes but B3 changes no orchestration source.                                                                                                                            |
| `apps/api/src/order/order.service.ts`                                                                                                                                                 | **Read only.**                             | `ensureJourneyContractPdfArtifact(...)` is the real generated-source-PDF caller before provider signing; signed-PDF archive remains the Fadada service's separate authority.                                                            |
| `apps/api/src/lease/lease-activation.engine.ts`; `lease-activation.persistence.ts`                                                                                                    | **Read only / B4 owner.**                  | No B3 import, construction, spy patch, or activation invocation. B3 only observes absence of Lease/period writes.                                                                                                                       |
| `apps/api/prisma/schema.prisma`; `apps/api/prisma/migrations/**`; `release/contracts/external-validation-applicability.v1.json`; package manifests                                    | **Read only.**                             | Authority/schema/external-applicability/script evidence; no schema, migration, external status, or script change.                                                                                                                       |

## Exact Test Harness Contract

The new file must construct these existing classes, not mocked service facades:

```ts
const repository = new SubscriptionJourneyRepository();
const journeyConfig = new SubscriptionJourneyRuntimeConfig(
  new ConfigService({ SUBSCRIPTION_JOURNEY_ENABLED: "true" })
);
const journeySignal = new SubscriptionJourneySignalService(repository, journeyConfig);
const audit = new AuditService(prisma);
const esign = new ESignService(
  audit,
  new ConfigService(),
  callbackProvider,
  prisma,
  undefined,
  undefined,
  undefined,
  journeySignal
);
const storage = new StorageService(
  new ConfigService({ UPLOAD_STORAGE_DRIVER: "local" }),
  memoryStorageProvider as never,
  {} as never
);
const archive = new TestFadadaSignedArtifactService(
  prisma,
  storage,
  journeySignal,
  audit,
  signedArtifactApi
);
const journey = new SubscriptionJourneyService(repository, prisma);
```

`TestFadadaSignedArtifactService` must only adapt constructor argument ordering and override protected `getApiClient(): FadadaSignedArtifactApi`; it must not override `archiveSignedContract`. Its constructor calls `super(prisma, storage, new ConfigService(), undefined, journeySignal, audit)` and retains the supplied API in a private field. The `callbackProvider` implements `verifyCallback` locally and makes `createSignTask`, `getSignerUrl`, and `querySignerStatus` throw `UNEXPECTED_PROVIDER_CALL`. `signedArtifactApi` returns a selectable invalid/valid byte buffer and counts `querySignResult`, `queryContractStatus`, `downloadSignedContract`, and `createContractFiling`. The in-memory `StorageProvider` records immutable bytes by key and counts `putObject`/`deleteObject`; the real `StorageService` selects it. No URL is fetched and no filesystem artifact is written.

Use these B3-local signatures and bytes in that same file so no later task must create a harness:

```ts
const PDF_BYTES = Buffer.from("%PDF-1.4\n%B3\n", "utf8");

class TestFadadaSignedArtifactService extends FadadaSignedArtifactService {
  constructor(
    prisma: PrismaService,
    storage: StorageService,
    journeySignal: SubscriptionJourneySignalService,
    audit: AuditService,
    private readonly api: FadadaSignedArtifactApi
  ) {
    super(prisma, storage, new ConfigService(), undefined, journeySignal, audit);
  }

  protected override getApiClient(): FadadaSignedArtifactApi {
    return this.api;
  }
}

async function activationWriteCounts(prisma: PrismaService, orderId: string) {
  const [leases, periods] = await Promise.all([
    prisma.lease.count({ where: { orderId } }),
    prisma.vehicleSubscriptionPeriod.count({ where: { orderId } })
  ]);
  return { leases, periods };
}

interface Stage1ArchiveFixture {
  applicationId: string;
  contractId: string;
  contractVersionId: string;
  customerId: string;
  journeyId: string;
  orderId: string;
  providerContractId: string;
  taskId: string;
  transactionId: string;
}

type Stage1ArchiveFixtureBuilder = (
  prisma: PrismaService,
  label: string
) => Promise<Stage1ArchiveFixture>;
```

Import the concrete services/types above, `ConfigService`, required Prisma enums and `PrismaService`, `createHash`/`randomUUID`, `Readable` from `node:stream`, Vitest lifecycle/assertion APIs, the two existing test helpers, and `StorageProvider` from `../src/storage/storage.types`. Do not import `LeaseActivationEngine` or `lease-activation.persistence`.

The callback boundary accepts only the test payload `{ providerContractId, providerTaskId, resultCode }`; `verifyCallback` returns that same payload with `verified: true` and maps `3000/3001/3003` to `FADADA_SIGN_COMPLETED/FADADA_SIGN_FAILED/FADADA_SIGN_REJECTED`. Its other three required `ESignProvider` methods throw `UNEXPECTED_PROVIDER_CALL`. Match the actual `FadadaSignedArtifactApi` return shapes: `querySignResult` returns `{ contractId, raw: {}, resultCode: "3000", status: "SIGNED" }`; `queryContractStatus` returns `{ contractId, raw: {}, status: "SIGNED" }`; `downloadSignedContract` returns `{ buffer: selectedBytes, contentType: "application/pdf", fileName: "signed.pdf", raw: {} }`; `createContractFiling` returns `{ contractId, raw: {} }`. No method fetches its synthetic URL. Implement storage as a `Map<string, Buffer>`: `putObject` copies bytes and returns `{ driver: "local", key, contentType, originalName, size }`, `getObject` returns `{ stream: Readable.from(storedBytes), contentLength: storedBytes.length, contentType: "application/pdf" }`, and `deleteObject` removes only that exact key. Track every count with B3-local `vi.fn` wrappers.

`PDF_BYTES` is a minimal signature fixture for the current `%PDF-`/size gate, not a renderable signed contract. This suite proves archive-byte identity and current admission checks, not complete PDF syntax, visual content, or supplier-signature validity; those remain explicit A2/A3 evidence gaps. Do not report this fixture as a real signed document.

Implement `const createStage1ArchiveFixture: Stage1ArchiveFixtureBuilder = async (...) => ...` in Task 1. It uses UUIDs and `insertRuntimeOrderGraph` / `insertRuntimeContract`, then inserts exactly:

- one `ContractVersion`/`Contract` in `SIGNING`, linked to an Order explicitly updated to `PENDING_SIGN`;
- one `ContractESignTask` with `provider=FADADA`, `signingStage=STAGE1_SUBSCRIPTION_CONTRACT`, `documentType=SUBSCRIPTION_CONTRACT`, `taskStatus=WAITING_CUSTOMER`, unique `taskNo`, `providerEnvelopeId=providerContractId`, `providerTaskId=transactionId`, `orderId`, `customerId`, and `requestSnapshot={ stage1MultiSlot: true }`;
- four required signer rows mirroring `STAGE1_SIGNING_SLOTS` at `apps/api/src/esign/esign.service.ts:270`: `STAGE1_BODY_CUSTOMER/CONTRACT_BODY/CUSTOMER_MANUAL_SIGN/CUSTOMER`, `STAGE1_BODY_PLATFORM/CONTRACT_BODY/PLATFORM_AUTO_SEAL/PLATFORM`, `STAGE1_ATTACHMENT1_CUSTOMER/ATTACHMENT1_SUBSCRIPTION_PLAN/CUSTOMER_MANUAL_SIGN/CUSTOMER`, and `STAGE1_ATTACHMENT1_PLATFORM/ATTACHMENT1_SUBSCRIPTION_PLAN/PLATFORM_AUTO_SEAL/PLATFORM`;
- each signer has `required=true`, its enum `slotId/documentType/providerActionType/signerType`, a distinct `providerSignerId`, and snapshot `{ required: true, slotId, documentType, providerActionType, signerRole, signingStage: "STAGE1_CONTRACT" }`; only `STAGE1_BODY_CUSTOMER` uses `providerSignerId=transactionId` and starts `PENDING`, while the other three start `SIGNED` with `signedAt`;
- one `SubscriptionJourney` with `applicationId`, `orderId`, `status=RUNNING`, `currentStepCode=FADADA_SIGNING_AND_ARCHIVE`, `currentStepStatus=RUNNING`, and a nested current Step with the same code/status; and
- zero Lease and zero VehicleSubscriptionPeriod rows for that Order.

Fixture setup may use Prisma writes; assertions must exercise the real service methods. The launcher provisions an isolated suite database, so the local fixture needs no cleanup framework and must not delete shared records.

---

## Fresh Execution Preflight

- [ ] **Step 1: Confirm approved source and classify local changes**

Run:

```powershell
git rev-parse HEAD
git status --short
```

Expected: HEAD is the implementation-approved descendant of `4b93f8abf4697d3970205d3d37e78e8a55b4ebd6`. Stop on overlapping edits. In particular, serialize any shared `database-test-manifest.v1.json` work and retain all previously merged suite IDs.

- [ ] **Step 2: Confirm retired fixed inputs remain absent without reading them**

Run:

```powershell
@(
  '.release-local/controlled-target.v1.json',
  '.release-local/secrets/bootstrap.json',
  '.release-local/secrets/migrate.json',
  '.release-local/secrets/verify.json',
  '.release-local/secrets/runtime-test.json'
) | ForEach-Object { [pscustomobject]@{ Path = $_; Exists = Test-Path -LiteralPath $_ } }
```

Expected: all five `Exists` values are `False`. If any is present, stop; do not read, migrate, delete, or reuse it.

- [ ] **Step 3: Generate code prerequisites without database access**

Run:

```powershell
pnpm --filter @subscription-saas/shared build
pnpm prisma:generate
```

Expected: both exit `0`. These commands establish no database or release-candidate identity.

---

### Task 1: Add the Real-Service PostgreSQL Counterexample Gate

**Files:**

- Create: `apps/api/test/stage1-contract-archive.integration.spec.ts`
- Read/Import: `apps/api/test/helpers/release-database-test-context.ts`
- Read/Import: `apps/api/test/helpers/runtime-domain-fixture.ts`
- Read: `apps/api/src/esign/esign.service.ts:1036`
- Read: `apps/api/src/esign/fadada/fadada-signed-artifact.service.ts:136`
- Read: `apps/api/src/subscription-journey/subscription-journey.service.ts:168`
- Read: `apps/api/src/subscription-journey/subscription-journey.repository.ts:912`
- Read: `apps/api/src/lease/lease-activation.engine.ts:393`

**Interfaces:**

- Consumes: `ESignService.handleCallback(providerParam, payload, headers?)`, `FadadaSignedArtifactService.archiveSignedContract({ taskId, actorId? })`, `SubscriptionJourneyService.dispatchSignalOutbox(tx, outbox)`, and the real Prisma delegates for Contract/Task/Signer/CallbackLog/FileObject/Journey/Event/Outbox.
- Produces: exactly three persistent characterization tests; no exported helper and no production API.

- [ ] **Step 1: Create the local real-service fixture and deterministic boundaries described above**

Obtain the runtime-equivalent URL only through:

```ts
const TEST_DATABASE_URL = requiredReleaseDatabaseTestContext(
  "apps/api/test/stage1-contract-archive.integration.spec.ts"
).databaseUrl;
```

Create `PrismaService` with this URL in `beforeAll`, call `onModuleInit`, and call `onModuleDestroy` in `afterAll`. Do not read `process.env.DATABASE_URL` directly.

- [ ] **Step 2: Add `persists callback monotonicity without admitting a platform archive`**

Use two isolated fixtures and the real `ESignService.handleCallback`:

1. On fixture A, deliver Fadada success `3000`, repeat the identical callback, then deliver late failure `3001` and rejection `3003` for the exact transaction/contract tuple.
2. Assert the task remains `COMPLETED`, all required signers remain `SIGNED`, Contract remains `SIGNED`, `signedAt` is stable, `archivedAt/fileId` remain null, no `FileObject` exists, the order is `PENDING_PAYMENT`, exactly one `fadada-task:<taskId>:completed` Journey event/outbox exists, and callback logs retain all deliveries without state regression.
3. On fixture B, deliver failure `3001` then late success `3000`. Assert task `FAILED`, Contract `SIGNING`, Order `PENDING_SIGN`, no archive tuple/file/signal, and `archiveSignedContract` rejects `FADADA_ARCHIVE_INVALID_TASK` before every signed-artifact API/storage counter remains zero.
4. For both fixtures assert Lease and VehicleSubscriptionPeriod counts remain zero.

The critical absence assertion is:

```ts
expect(contract).toMatchObject({
  archivedAt: null,
  fileId: null,
  status: ContractStatus.SIGNED
});
expect(
  await prisma.fileObject.count({
    where: { objectKey: { contains: `contracts/${contract.id}/` } }
  })
).toBe(0);
expect(await activationWriteCounts(prisma, orderId)).toEqual({ leases: 0, periods: 0 });
```

For fixture B assert `ContractStatus.SIGNING`, not `SIGNED`.

- [ ] **Step 3: Add `admits exactly one persisted PDF archive and preserves non-archive authorities`**

Complete the callback and snapshot ContractVersion, Contract `signedAt`, Order, and Lease/period counts. First make the deterministic API return non-PDF bytes and call the real `archiveSignedContract`; assert rejection, unchanged Contract `SIGNED`/null archive fields, no matching FileObject/archive event, zero storage writes, and zero activation writes. Then select `PDF_BYTES`, call the same real method successfully, deliver a duplicate success callback and a late `3001` callback, snapshot provider/storage counters, and call `archiveSignedContract` once more.

After the first call assert:

```ts
expect(contract).toMatchObject({
  archivedAt: expect.any(Date),
  fileId: expect.any(String),
  signedAt: signedAtBefore,
  status: ContractStatus.ARCHIVED
});
expect(file).toMatchObject({
  bucket: "application-materials",
  contentSha256: createHash("sha256").update(PDF_BYTES).digest("hex"),
  mimeType: "application/pdf",
  objectKey: first.signedPdfObjectKey,
  originalName: `${contract.contractNo}-signed.pdf`,
  sizeBytes: BigInt(PDF_BYTES.length)
});
expect(contractVersionAfter).toEqual(contractVersionBefore);
expect(orderAfter.orderStatus).toBe(OrderStatus.PENDING_PAYMENT);
expect(await activationWriteCounts(prisma, orderId)).toEqual({ leases: 0, periods: 0 });
```

Also assert the Contract `fileId` resolves to that exact FileObject, storage bytes equal `PDF_BYTES`, and exactly one `fadada-artifact:<taskId>:archived` Journey event/outbox and one archive audit exist. The post-archive callbacks must leave the Contract `ARCHIVED`, retain the same `fileId/archivedAt/signedAt`, and add no task/archive signal. After the duplicate archive call assert `{ archived: false, skippedReason: "SIGNED_PDF_ALREADY_ARCHIVED" }`, still one FileObject/event/outbox, and API/storage call counters unchanged from immediately after the successful call. This proves late callbacks cannot revoke platform admission and duplicate archive short-circuits before provider/storage.

- [ ] **Step 4: Add `converges archive-first and repeated signal dispatch without a B4 write`**

Complete and archive a fresh fixture but do not dispatch either persisted signal outbox. Select the `FADADA_ARTIFACT_ARCHIVED` outbox and dispatch it first inside a Prisma transaction; then dispatch the older `FADADA_TASK_COMPLETED` outbox twice and the archive outbox once more.

Assert:

```ts
expect(journeyAfter.currentStepCode).toBe(SubscriptionJourneyStepCode.CUSTOMER_JSAPI_PAYMENT);
expect(signingStepAfter.status).toBe(SubscriptionJourneyStepStatus.COMPLETED);
expect(
  await prisma.subscriptionJourneyEvent.count({
    where: {
      eventKey:
        `journey:${journeyId}:step:FADADA_SIGNING_AND_ARCHIVE:` + `contract:${contractId}:archived`
    }
  })
).toBe(1);
expect(
  await prisma.subscriptionJourneyJob.count({
    where: {
      jobType: SubscriptionJourneyJobType.RECONCILE_FADADA_SIGNING,
      journeyId
    }
  })
).toBe(0);
expect(await activationWriteCounts(prisma, orderId)).toEqual({ leases: 0, periods: 0 });
```

The zero reconcile-job assertion is specific to archive-first delivery: once archive authority advances the step, the late task-completed process fact is ignored. Do not call `markOutboxProcessed`; this test deliberately invokes the handler repeatedly with the same persisted row to prove handler-level convergence.

- [ ] **Step 5: Stage the new file, then run the classification RED before editing the manifest**

Run:

```powershell
git add -- apps/api/test/stage1-contract-archive.integration.spec.ts
git diff --cached --check
pnpm release:database-tests:discover
```

Expected: the staged diff check exits `0`; discovery exits non-zero with `DATABASE_TEST_UNCLASSIFIED` and report counts show exactly one unclassified path, `apps/api/test/stage1-contract-archive.integration.spec.ts`. Discovery derives its universe from `git ls-files`, so staging the new path is mandatory. This is a governance RED only. Do not invent a failing product assertion when the audited source appears conforming.

Do not run the database suite yet: the file has no approved suite identity, and the launcher requires a clean trusted checkout.

---

### Task 2: Register the B3 Suite Without Replacing Shared Manifest State

**Files:**

- Modify: `release/contracts/database-test-manifest.v1.json`
- Test: `apps/api/test/stage1-contract-archive.integration.spec.ts`
- Read/Execute: `scripts/release/discover-database-tests.mjs`
- Read/Execute later: `scripts/release/run-database-suite.mjs`

**Interfaces:**

- Produces suite identity `api.stage1-contract-archive.postgres`, `runtime-equivalent-test` database role, no external dependency, fresh/snapshot applicability, one shard, complete counts, and the existing database barrier.
- Consumes the current shared manifest after B1/B5/R integration; the edit is an additive merge, never a whole-file replacement.

- [ ] **Step 1: Reread the latest manifest and add the suite ID to `batch-b`**

Insert `"api.stage1-contract-archive.postgres"` lexicographically before the existing Stage 2 entries while retaining every current suite ID.

- [ ] **Step 2: Add exactly this suite object before `api.stage2-handover-pdf.postgres`**

```json
{
  "suiteId": "api.stage1-contract-archive.postgres",
  "runner": "vitest",
  "files": ["apps/api/test/stage1-contract-archive.integration.spec.ts"],
  "chainApplicability": {
    "fresh": { "status": "required" },
    "snapshot": { "status": "required" }
  },
  "databaseRole": "runtime-equivalent-test",
  "parallelism": { "mode": "parallel", "maxShards": 1 },
  "timeoutMs": 900000,
  "barrier": "database",
  "externalDependency": "none",
  "owner": "api-database-test",
  "expectedCountPolicy": { "mode": "complete" }
}
```

Do not change `release/contracts/external-validation-applicability.v1.json`: the local suite has no network dependency and does not satisfy `stage1.esign` real-provider verification.

- [ ] **Step 3: Run discovery GREEN and static formatting checks**

Run:

```powershell
pnpm release:contracts:verify
pnpm release:database-tests:discover
pnpm exec prettier --check apps/api/test/stage1-contract-archive.integration.spec.ts release/contracts/database-test-manifest.v1.json
git diff --check
```

Expected: all exit `0`; contract verification accepts the minimally merged manifest and discovery reports `unclassifiedCount=0`, with `candidateCount = manifestedCount + exceptedCount`. No database is created by these checks.

- [ ] **Step 4: Review the exact ownership diff**

Run:

```powershell
git diff -- apps/api/test/stage1-contract-archive.integration.spec.ts release/contracts/database-test-manifest.v1.json
git status --short
```

Expected: only the B3 spec and the two additive manifest insertions are part of this task. If another plan changed the manifest concurrently, rebase the small insertion on the latest file and repeat discovery; never discard its entries.

- [ ] **Step 5: Commit the clean runnable source boundary after implementation approval**

```powershell
git add -- apps/api/test/stage1-contract-archive.integration.spec.ts release/contracts/database-test-manifest.v1.json
git diff --cached --check
git diff --cached --name-only
pnpm release:contracts:verify
pnpm release:database-tests:discover
pnpm exec prettier --check apps/api/test/stage1-contract-archive.integration.spec.ts release/contracts/database-test-manifest.v1.json
git commit -m "test: validate Stage 1 contract archive admission"
```

Expected before commit: every gate exits `0`, and `git diff --cached --name-only` contains exactly the new B3 spec and the shared manifest. The commit is required before the governed launcher because its source-provenance check rejects a dirty checkout. It is an execution-time step, not authorization to commit during planning.

---

### Task 3: Run Fresh Validation and Record B3 Evidence

**Files:**

- Test: `apps/api/test/esign.spec.ts`
- Test: `apps/api/test/fadada-archive.spec.ts`
- Test: `apps/api/test/subscription-journey-esign.spec.ts`
- Test: `apps/api/test/lease-activation.spec.ts`
- Test: `apps/api/test/stage1-contract-archive.integration.spec.ts`
- Create: `docs/acceptance/2026-09-06-stage1-b3-contract-archive-validation.md`
- Read/Execute: `scripts/release/run-database-suite.mjs`

**Interfaces:**

- Produces one focused unit result and one governed fresh `database-suite-report.v1` for `api.stage1-contract-archive.postgres`.
- Produces a non-promotable B3 evidence note; it does not edit the shared execution index, supply snapshot evidence, or close external validation.

- [ ] **Step 1: Confirm the suite-launch source is clean**

Run:

```powershell
git status --short
git rev-parse HEAD
```

Expected: empty status and the just-reviewed B3 implementation commit. If dirty, stop and classify it; do not bypass `DATABASE_LAUNCHER_SOURCE_CHECKOUT_DIRTY`.

- [ ] **Step 2: Run the existing mock characterizations unchanged**

Run:

```powershell
pnpm --filter @subscription-saas/api exec vitest run --project unit test/esign.spec.ts test/fadada-archive.spec.ts test/subscription-journey-esign.spec.ts test/lease-activation.spec.ts
```

Expected: exit `0`; every selected test passes with `failed=0`, `skipped=0`, and `todo=0`. Record the observed counts; do not copy historical P1 counts.

- [ ] **Step 3: Run only the new suite through the fresh self-provisioning launcher**

Run:

```powershell
node scripts/release/run-database-suite.mjs --suite-id api.stage1-contract-archive.postgres --chain fresh
```

Expected: exit `0`; JSON has `schemaVersion="database-suite-report.v1"`, `suiteId="api.stage1-contract-archive.postgres"`, `chain="fresh"`, and `terminalStatus="PASSED"`. Its actual `counts` schema is `cancelled/collected/executed/failed/filtered/passed/selected/skipped/todo`; require `collected=selected=executed=passed=3` and every other count `0`. Require `target.targetFingerprint` with `sha256:` syntax, plus the actual runtime-role fields `target.roleAttributes`, `target.canCreateSchema=false`, `target.schemaOwner=false`, and `target.objectOwner=false`; require a `sha256:` `sanitizedLogDigest`. The launcher provisions and cleans its own target. Do not rerun against P1 records, pass a URL, or create a second target lifecycle.

If the process ends with `INTERRUPTED_UNKNOWN`, retained-target/custody error, or cleanup uncertainty, stop and hand the exact run/incident identity to the release owner; do not rerun or delete resources under B3.

- [ ] **Step 4: Apply the production-counterexample stop gate**

If any new PG assertion fails, do not edit production. The executor report must include:

```text
test name:
source HEAD:
expected Contract/Task/FileObject/Journey/Lease facts:
actual persisted facts:
unexpected provider/storage call counts:
exact source method implicated:
smallest proposed file/interface boundary:
```

A subsequent amendment may authorize only the named method and its direct regression test. It must remain separate from B4 activation and must not introduce a generic helper/framework.

- [ ] **Step 5: Create the independent evidence note from observed output**

Write `docs/acceptance/2026-09-06-stage1-b3-contract-archive-validation.md` with:

1. source HEAD and date;
2. the exact unit and fresh-suite commands;
3. observed unit counts and suite `runId`, `operationId`, `target.targetFingerprint`, `target.roleAttributes`, `target.canCreateSchema`, `target.schemaOwner`, `target.objectOwner`, all nine count fields, manifest/discovery digests, sanitized-log digest, and terminal status copied from the fresh JSON;
4. an assertion matrix for callback-only absence of archive facts, archive tuple + actual FileObject, duplicate short-circuit counters, archive-first signal convergence, unchanged ContractVersion/payment state, and zero Lease/VehicleSubscriptionPeriod rows;
5. an explicit statement that the existing golden path fabricates archive state and is not this proof;
6. unresolved limits: snapshot chain not run, real Fadada/OSS not contacted, `stage1.esign` remains `must-external-verify`, and no B4 activation was executed.

Do not include secrets, callback payload contents, signed bytes, retired identities, object access URLs, or promotion language.

- [ ] **Step 6: Verify and commit only the evidence note after implementation approval**

Run:

```powershell
pnpm exec prettier --check docs/acceptance/2026-09-06-stage1-b3-contract-archive-validation.md
git diff --check
git status --short
```

Expected: static checks exit `0`; only the evidence note is uncommitted. Then:

```powershell
git add -- docs/acceptance/2026-09-06-stage1-b3-contract-archive-validation.md
git diff --cached --check
git diff --cached --name-only
pnpm release:contracts:verify
pnpm release:database-tests:discover
pnpm exec prettier --check docs/acceptance/2026-09-06-stage1-b3-contract-archive-validation.md
git commit -m "docs: record Stage 1 B3 archive validation"
```

Expected before commit: all gates exit `0`, discovery remains fully classified, and `git diff --cached --name-only` contains only the B3 evidence note.

## Completion Criteria

B3 is locally complete only when all of the following are true:

- the new PG file is manifested exactly once and discovery has no unclassified candidate;
- existing mock characterizations remain green without edits;
- the fresh governed suite calls real ESign/archive/journey services and passes all three persistent tests;
- callback completion alone leaves Contract `SIGNED` with no archive admission facts;
- archive admission has a resolvable valid PDF FileObject and preserves ContractVersion and `signedAt`;
- duplicate/late callbacks, duplicate archive, and archive-first/repeated outbox dispatch converge to one authoritative transition;
- no Lease or VehicleSubscriptionPeriod is created or changed, and no provider network method is called;
- the evidence note contains current observed identities/counts/digests and the external/snapshot/B4 limitations; and
- no production, schema, migration, RBAC, flag, package, external-applicability, shared-index, or activation file changed.

Passing B3 is not real-provider acceptance, snapshot-chain acceptance, B4 activation proof, or release promotion.
