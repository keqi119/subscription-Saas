# Stage 1 B3 合同、电子签与 PDF 归档独立验证实施计划

> **Status: BLOCKED — Task 3R executed and stopped on a counted failure; Task 3S is a proposal pending explicit human approval.** Task 3R was approved in plan commit `c9f19083`, implemented at `d208d33fd77b33d006f53f039a4f01e81597af42`, and recorded at baseline HEAD `b6942a91f67ec3cecc627989dd6382d1fd53e495`. The present authorization is document-only: it permits amending this plan, not editing the test, running build/generation/unit/database commands, creating evidence, changing production, contacting external services, or promoting a release.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Independently validate that an electronic-signature task completion is only a provider-process fact, while Stage 1 platform archive admission requires the persisted `Contract` archive tuple and its actual PDF `FileObject`; duplicate and out-of-order callbacks/signals must converge without creating B4 activation facts.

**Architecture:** Preserve the existing authority split: `ESignService.handleCallback` owns signer/task completion and the `SIGNED` transition; `FadadaSignedArtifactService.archiveSignedContract` validates, stores, hashes, and atomically admits the archived PDF; `SubscriptionJourneyService.dispatchSignalOutbox` completes `FADADA_SIGNING_AND_ARCHIVE` only from `FADADA_ARTIFACT_ARCHIVED`. Completion advances exactly one state-machine step to `INITIAL_BILLING`; later persisted signals at that step enqueue one stable-key `GENERATE_INITIAL_BILLS` job but do not execute billing, a worker, or payment. Task 3S therefore proposes only correcting the B3-local successor oracle and rerunning the existing governed suite once from a new clean source.

**Tech Stack:** TypeScript 6, NestJS 11, Prisma 7/PostgreSQL 17, Vitest 4, pnpm 11, the existing release database-suite launcher.

**Spec:** `DEV_SPEC.md`; `docs/superpowers/specs/2026-09-06-stage1-minimal-controlled-release-decision.zh-CN.md`; `docs/superpowers/plans/2026-09-06-stage1-mainline-minimal-release-implementation-plan.md`; `docs/superpowers/specs/2026-09-01-stage1-s0-authority-and-temporary-asset-governance-design.zh-CN.md`; `docs/acceptance/2026-09-06-stage1-mainline-execution-index.md`

## 审批摘要

- 首轮 B3 专属 PostgreSQL 测试和数据库清单纳管已在 `05f33a32` 完成；Task 3R 的夹具修正在 `d208d33f` 完成。Task 3R 的一次 fresh 运行执行了三个用例，结果为 `passed=2`、`failed=1`，因此已按 STOP 规则结束。
- 电子签任务完成只证明供应商流程事实；平台归档准入需要完整 Contract 归档元组和可解析的 PDF FileObject，且 `ARCHIVED` 不被解释为法律生效时间。
- 不调用真实 Fadada/OSS，不写 Lease/VehicleSubscriptionPeriod，不运行 B4 激活；snapshot 链和真实供应商验证继续留给 R3/A2/A3。
- 当前只获准编写并提交这份 Task 3S 计划修订。Task 3S 的测试修改、静态检查、提交、生成、单元测试、fresh 运行和新证据 note 都必须另获用户明确批准；B3 尚未通过，其他 B/R 工作线的审批状态彼此独立，主线 Task 30、外部验证与发布晋级保持冻结。
- 用户另行授权的未来外部路线可以在逐项确认候选、窗口、专用测试资产和金额后使用 Staging app/API/DB，以及生产 Fadada 和微信支付/退款；严禁生产业务库、普通客户或运营车辆。实际签署、支付、退款分别授权，退款必须独立授权。该路线不扩大或执行本地 Task 3S，不修改当前 runbook/applicability 文件，真实联通另建证据；未来 fresh 由另一线程负责，本线程不运行。

## Global Constraints

- B3's original bounded scope was approved at `51981b32`; Task 3R was separately approved at `c9f19083` and has finished `FAILED`. Task 3S is independently pending human approval. B3 neither depends on nor gates the approval state of other B/R work lines.
- The Task 3S planning baseline is clean HEAD `b6942a91f67ec3cecc627989dd6382d1fd53e495`. A future executor must start from the independently committed approved plan, then freeze the actual full clean-source SHA only after the one-line test commit; no placeholder or anticipated SHA is launch provenance.
- P0/P1 are closed and their controlled targets were retired. The fixed target record and four fixed secret files are absent. Historical P1 run IDs, database identities, digests, and counts are context only and must not be reused as B3 evidence.
- The only B3 database entry is the existing self-provisioning `scripts/release/run-database-suite.mjs --chain fresh`. Do not create a bootstrap, cleanup, credential, target-record, evidence-schema, test context, or suite launcher. Do not use an ambient `DATABASE_URL` or directly invoke the database Vitest project.
- Do not read credential contents or retirement archives. Do not call Fadada, OSS, cloud, GitHub, Staging, production, notification, payment, or other external services. The suite's deterministic adapters must throw if an unplanned provider method is reached.
- `ContractVersion` remains the immutable text/template authority. `ContractESignTask` and `ContractESignSigner` remain provider-process facts. Platform archive admission is the `Contract` tuple `status=ARCHIVED`, non-null `archivedAt`, non-null `fileId`, and a matching, valid PDF `FileObject`; `ARCHIVED` must not be described as legal-effective time.
- The archive path preserves `signedAt` and order payment state. Task 3S must not execute or force the queued initial-billing job merely to satisfy the obsolete payment-step oracle, and must not create/update `Lease`, `VehicleSubscriptionPeriod`, delivery/handover activation, payment, or any B4 fact. `apps/api/src/lease/lease-activation.engine.ts` is read/test-only and B4-owned.
- Do not add assertions, helpers, schema/models/enums, migrations, RBAC permissions, feature flags, package scripts, suite/manifest entries, shared fixture frameworks, or production fixes. Task 3S changes exactly one existing expression and otherwise preserves every byte of the B3 integration spec.
- Historical Tasks 1–2 used discovery of the then-new unclassified database file as their only governance RED. Neither completed Task 3R nor proposed Task 3S recreates that RED, adds a suite, or modifies the manifest.
- If the future unit/prerequisite sequence fails, stop before fresh execution and record it as not run. If the one fresh launch is not completely passing, preserve the exact governed failure/incident and create only its truthful closeout note; do not perform more B3 testing or code changes without another separate approval.
- Snapshot-chain execution remains required by manifest policy but belongs to the later R3/A2 controlled snapshot input. B3 runs only the fresh chain and does not claim snapshot or real-provider evidence.

## Current Blocked State and Immutable Failed-Run Evidence

- Tasks 1–2 were implemented at `05f33a32`; the first Task 3 launch used clean source `16adab17` and was recorded at `a3709bb6`. The original preflight and Tasks 1–3 below are read-only historical provenance: do not rerun them, recreate their files, change their checkboxes, or edit the manifest under this revision.
- The first launch had `runId=3597a875-3e3f-4a0a-b25c-55a271060835`, `operationId=5de6db6b-e0de-4e3f-a92e-3db830c7d519`, `passed=2`, `failed=1`, and `terminalStatus=FAILED`. No retry occurred.
- Its canonical 963-byte report remains `.release-local/evidence/evidence/623c488b4c59990aa5e283de2318203009694612bcc7e7281d7c7a0f136342e9.json`, digest `sha256:623c488b4c59990aa5e283de2318203009694612bcc7e7281d7c7a0f136342e9`. Its receipt remains `.release-local/evidence/receipts/ed43e6ed-e06b-458e-b9ba-2eafbea8e1b5.json`, whose file digest is `sha256:200f9d312b26d5076070d8719b43af263bdc6853642dcb40085b006f69744110`.
- The historical acceptance note `docs/acceptance/2026-09-06-stage1-b3-contract-archive-validation.md` remains byte-for-byte unchanged with digest `sha256:bbcad66c3eb5c0918285123c8c69bab74ae8ffaac171b7a5e778a7fb7d9008a4`. A continuation must not overwrite, amend, or retroactively reclassify the report, receipt, or note.
- The first-run report retained neither the exact Prisma error code nor its message/constraint. Task 3R's later advancement past that point is consistent with the static Journey-ID fixture correlation, but the newer failure cannot be used to infer or retroactively claim the first run's exact root cause.
- Task 3R removed the Journey UUID and returned Prisma's actual ID at `d208d33fd77b33d006f53f039a4f01e81597af42`. Its shared build and generation succeeded, and the unchanged four-file unit selection passed exactly 4 files / 161 tests under Node `24.14.0` and pnpm `11.4.0`; this is not Node 22 final-image evidence.
- The one Task 3R fresh run had `runId=77300999-de9d-40ec-8a90-4bf0bb136e47`, `operationId=f2e16277-a1ae-4d87-818e-91dd89dfeabb`, `passed=2`, `failed=1`, and `terminalStatus=FAILED`. Its third case reached line 758 and observed `INITIAL_BILLING` where the historical oracle expected `CUSTOMER_JSAPI_PAYMENT`; every later third-case assertion was `NOT_REACHED`. No retry or post-failure code/test change occurred.
- The Task 3R report remains `.release-local/evidence/evidence/3d81ca096b36c2619cc6e4ef27fcd495e8b55761aadb38dc0ab87b79bbd240ab.json`, file digest `sha256:3d81ca096b36c2619cc6e4ef27fcd495e8b55761aadb38dc0ab87b79bbd240ab`. Its receipt remains `.release-local/evidence/receipts/24d18dfc-fb4a-437c-b17e-fbb277f1c43b.json`, file digest `sha256:53ad0418ee000985e002c143a1e41883fdc95282ae489cbb7c5ac388d716ee46`. The committed Task 3R note `docs/acceptance/2026-09-07-stage1-b3-contract-archive-validation-rerun.md` remains immutable with file digest `sha256:3354b626918721ac166b747b265e04b9a6c59b5e005c6e219f46b0a2923b951e`.
- The approved design places `INITIAL_BILLING` immediately after signing/archive (`2026-08-06-stage1-golden-path-orchestration-design.zh-CN.md:101-113`, `:441-447`), matching `subscription-journey-state-machine.ts:9-11` and repository advancement at `subscription-journey.repository.ts:1346-1385`. The archive signal only completes signing (`subscription-journey.service.ts:253-275`); later signals at `INITIAL_BILLING` converge on one stable-key queued `GENERATE_INITIAL_BILLS` job (`:340-365`), whose execution alone generates bills and completes billing (`:1161-1201`). The B3 test invokes no worker or billing job. Therefore the line-758 oracle originated in historical plan line 313 / implementation `05f33a32`, not in a product regression. The remaining third-case assertions are statically consistent with this diagnosis but have not passed dynamically.

---

## Audited Source and Evidence Boundaries

| Boundary                        | Source evidence at the planning baseline                                                                                                                                                                                                                                                                                                                                                      | B3 treatment                                                                                                                                                                                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract text and archive facts | `apps/api/prisma/schema.prisma:7976`, `:8005`, and `:8511` separate `ContractVersion`, `Contract`, and `FileObject`. The Contract archive tuple is independent of task completion.                                                                                                                                                                                                            | Persist and reread all four admission facts plus PDF MIME, byte count, object identity, and SHA-256. Assert the ContractVersion row is unchanged.                                                                                                                             |
| Callback process                | `ESignService.handleCallback(...)` at `apps/api/src/esign/esign.service.ts:1036`, `handleFadadaCallback(...)` at `:2102`, `findCallbackTask(...)` at `:2311`, and `completeTask(...)` at `:2375` verify/correlate callbacks, make task/signer completion monotonic, set Contract `SIGNED`, and emit the stable task-completed signal. They do not admit the archive or call activation.       | Call the real `ESignService` against PostgreSQL with only `ESignProvider.verifyCallback` deterministic. Cover replay, success-then-failure/rejection, and failure/rejection-then-success.                                                                                     |
| Archive admission               | `FadadaSignedArtifactService.archiveSignedContract(...)` at `apps/api/src/esign/fadada/fadada-signed-artifact.service.ts:136` requires a completed Fadada task/all required signers, validates `%PDF`, stores bytes, creates `FileObject`, and transactionally writes the Contract archive tuple and stable archive signal. The existing archive tuple returns before provider/storage calls. | Call the real service with a subclass overriding only `getApiClient()` and a real `StorageService` over an in-memory `StorageProvider`; assert success, rollback/precondition negatives, and duplicate short-circuit counters.                                                |
| Journey admission               | `SubscriptionJourneyService.dispatchSignalOutbox(...)` at `apps/api/src/subscription-journey/subscription-journey.service.ts:253-275` completes signing only for `FADADA_ARTIFACT_ARCHIVED`; the state machine's immediate successor is `INITIAL_BILLING`. Generic dispatch at `:340-365` enqueues the current step's stable-key job.                                                         | Correct only the obsolete successor oracle. Repeated late signals must not create a signing reconcile job or backslide, but they are not described as all ignored: at `INITIAL_BILLING` they converge on one queued initial-billing job, which this B3 test does not execute. |
| B4 prerequisite, not B3 write   | `LeaseActivationEngine.readAuthorityFacts(...)` at `apps/api/src/lease/lease-activation.engine.ts:393` and `evaluateFacts(...)` at `:465` require the complete archive tuple plus the referenced FileObject; missing facts yield `CONTRACT_ARCHIVED_ARTIFACT_MISSING`.                                                                                                                        | Re-run the existing unit test read-only. In the PG suite query `Lease` and `VehicleSubscriptionPeriod` counts before/after; do not instantiate or call `LeaseActivationEngine`.                                                                                               |
| Existing mock coverage          | `apps/api/test/esign.spec.ts` covers verified/unverified/unknown/mismatched, duplicate, and late callbacks; `fadada-archive.spec.ts` covers PDF/archive success, invalid bytes/storage/finalization failures, and duplicate archive; `subscription-journey-esign.spec.ts` covers the task-vs-archive signal split; `lease-activation.spec.ts:56` rejects `SIGNED` without archive facts.      | Re-run unchanged as fast characterization. These in-memory tests are not PostgreSQL proof.                                                                                                                                                                                    |
| Existing PostgreSQL limit       | `subscription-journey-golden-path.e2e-spec.ts:344` directly creates an ESign task and updates Contract to `ARCHIVED`; it does not call `ESignService` or `FadadaSignedArtifactService`. Other Journey PG suites cover repository/integrity/failure recovery, not this service boundary.                                                                                                       | Add one narrowly owned real-service PG suite rather than treating the synthetic golden path as B3 proof.                                                                                                                                                                      |
| External-provider limit         | `release/contracts/external-validation-applicability.v1.json` retains `stage1.esign = must-external-verify` because a mock/deterministic provider cannot prove real signing and archive connectivity.                                                                                                                                                                                         | Read only. B3 fresh evidence cannot close or downgrade this A3 obligation.                                                                                                                                                                                                    |

## File Ownership and Cross-Package Coordination

| Path                                                                                                                                                                                                            | Historical / current ownership                                 | Consumers / coordination                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/superpowers/plans/2026-09-06-stage1-b3-contract-archive-validation-plan.md`                                                                                                                               | **Current document-only modify.**                              | This is the sole currently authorized write; its commit grants no Task 3S execution permission.                                                                              |
| `apps/api/test/stage1-contract-archive.integration.spec.ts`                                                                                                                                                     | **Historical create/Task 3R modify; Task 3S proposed modify.** | After separate approval, replace only the line-758 expected step expression with literal `SubscriptionJourneyStepCode.INITIAL_BILLING`; all other bytes remain unchanged.    |
| `release/contracts/database-test-manifest.v1.json`                                                                                                                                                              | **Historical modify; current read only.**                      | The suite is already manifested. Task 3S must not replay discovery RED, add another suite entry, replace the file, or reformat it.                                           |
| `docs/acceptance/2026-09-06-stage1-b3-contract-archive-validation.md`                                                                                                                                           | **Historical create; current immutable/read only.**            | First-run `FAILED` evidence at `a3709bb6`; never overwrite, amend, or reclassify it.                                                                                         |
| `docs/acceptance/2026-09-07-stage1-b3-contract-archive-validation-rerun.md`                                                                                                                                     | **Task 3R immutable/read only.**                               | Counted-failure evidence at `b6942a91`; never overwrite, amend, or reclassify it.                                                                                            |
| `docs/acceptance/2026-09-07-stage1-b3-contract-archive-transition-validation.md`                                                                                                                                | **Task 3S proposed create only after an approved run.**        | Must be absent at preflight; records only the one future run and never collides with or replaces either historical note.                                                     |
| `apps/api/test/esign.spec.ts`; `fadada-archive.spec.ts`; `subscription-journey-esign.spec.ts`; `lease-activation.spec.ts`; `subscription-journey-state-machine.spec.ts`; `subscription-journey-payment.spec.ts` | **Read/Test only.**                                            | The last two are newly disclosed read-only unit selections for Task 3S. No unit body, suite identity, or manifest entry changes.                                             |
| `apps/api/test/helpers/release-database-test-context.ts`; `runtime-domain-fixture.ts`                                                                                                                           | **Read/Import only.**                                          | Existing runtime-equivalent identity and minimal database graph. No new shared fixture API is authorized.                                                                    |
| `apps/api/src/esign/esign.service.ts`; `esign.provider.ts`; `esign.controller.ts`; `fadada/fadada-signed-artifact.service.ts`; `apps/api/src/storage/storage.service.ts`                                        | **Read only.**                                                 | Real admin/public callback and archive services/callers. A failing counterexample must name one exact method before seeking separate modification approval.                  |
| `apps/api/src/subscription-journey/subscription-journey.service.ts`; `subscription-journey-signal.service.ts`; `subscription-journey.repository.ts`; `subscription-journey.config.ts`                           | **Read only.**                                                 | Shared B1–B6 signal/outbox logic; the test composes the real classes but B3 changes no orchestration source.                                                                 |
| `apps/api/src/order/order.service.ts`                                                                                                                                                                           | **Read only.**                                                 | `ensureJourneyContractPdfArtifact(...)` is the real generated-source-PDF caller before provider signing; signed-PDF archive remains the Fadada service's separate authority. |
| `apps/api/src/lease/lease-activation.engine.ts`; `lease-activation.persistence.ts`                                                                                                                              | **Read only / B4 owner.**                                      | No B3 import, construction, spy patch, or activation invocation. B3 only observes absence of Lease/period writes.                                                            |
| `apps/api/prisma/schema.prisma`; `apps/api/prisma/migrations/**`; `release/contracts/external-validation-applicability.v1.json`; package manifests                                                              | **Read only.**                                                 | Authority/schema/external-applicability/script evidence; no schema, migration, external status, or script change.                                                            |

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

> **Historical execution record:** The original preflight and Tasks 1–3 are preserved below as the instructions that produced `05f33a32` and the failed first run. They are not a live checklist and must not be replayed by the continuation. Their statement that the fixture “uses UUIDs” describes the old Journey UUID too; Task 3R supersedes only that Journey identity while retaining every other UUID.

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

---

## HISTORICAL / NOT LIVE — Task 3R and Its Completion Criteria

> The complete Task 3R section and its completion criteria below are immutable execution provenance. They retain their former “pending,” “only live task,” and “all assertions unchanged” language exactly as approved at `c9f19083`; none of those clauses is current authorization. The live Task 3S section after this historical block supersedes them only for its one named expectation expression and grants no broader permission.

### Task 3R: Correct the B3-Local Journey Fixture and Produce Independent Rerun Evidence

> **Approval gate:** This continuation is a proposal pending review. Execute none of it until the user explicitly approves the revised plan.
>
> **Current write boundary:** Task 3R is the only live task. Its only writable paths are the existing B3 spec and the new rerun note below. For the Step 3 and Step 6 command sequences, run commands one at a time in order: any non-zero exit or unexpected path stops the sequence before later commands, including `git add`/`git commit`; do not continue to database execution. Such a stop applies only to this B3 continuation and does not freeze independently approved work lines.

**Files:**

- Modify: `apps/api/test/stage1-contract-archive.integration.spec.ts`
- Create: `docs/acceptance/2026-09-07-stage1-b3-contract-archive-validation-rerun.md`
- Read only: `docs/acceptance/2026-09-06-stage1-b3-contract-archive-validation.md`
- Read/Execute unchanged: `scripts/release/run-database-suite.mjs`

**Interfaces:**

- Preserve the existing fixture transaction and all three test bodies. `prisma.$transaction(...)` returns the actual `SubscriptionJourney.id` created by Prisma, and the fixture returns that value as `journeyId`.
- Preserve UUID identities for Application, Contract, ContractVersion, Customer, Order, task, and provider facts. Do not truncate, hash, handcraft, or otherwise substitute the Journey ID or any event key.
- Do not change product code, Prisma schema/migrations, shared helpers, manifest, launcher, package scripts, or historical evidence.

- [ ] **Step 1: Reconfirm the narrow static boundary**

Before touching the fixture, require the approved version of this revised plan to exist in its own commit and run:

```powershell
git status --short
git rev-parse HEAD
```

Expected: checkout and index are empty at the approved-plan starting SHA. A dirty plan document or any unrelated staged/unstaged path stops Task 3R for classification; do not stage, commit, clean, or discard those changes on the user's behalf, and never fold this pending-review document into the fixture commit.

Then read the fixture at source commit `05f33a32` and the production create branch at `apps/api/src/subscription-journey/subscription-journey.repository.ts:119-131`. Confirm production omits `SubscriptionJourney.id` and relies on `@default(cuid())`; treat the 131/138 versus approximately 120/127 length calculation only as static fixture-correlation evidence. Do not claim an exact database error absent the retained Prisma code/message.

- [ ] **Step 2: Make only this fixture edit**

Apply the following local shape without moving other setup out of the existing callback transaction:

```diff
-  const journeyId = randomUUID();
   const orderId = randomUUID();

-  await prisma.$transaction(async (tx) => {
+  const journeyId = await prisma.$transaction(async (tx) => {
-    await tx.subscriptionJourney.create({
+    const createdJourney = await tx.subscriptionJourney.create({
       data: {
         applicationId,
         currentStepCode: SubscriptionJourneyStepCode.FADADA_SIGNING_AND_ARCHIVE,
         currentStepStatus: SubscriptionJourneyStepStatus.RUNNING,
-        id: journeyId,
         orderId,
         status: SubscriptionJourneyStatus.RUNNING,
         steps: {
           create: {
             code: SubscriptionJourneyStepCode.FADADA_SIGNING_AND_ARCHIVE,
             status: SubscriptionJourneyStepStatus.RUNNING
           }
         }
       }
     });
+    return createdJourney.id;
   });
```

Do not call `createOrGetForApplication`, because this B3 fixture must retain its existing signing-step state and surrounding writes. Do not add a helper or modify the three assertions/event-key rules.

- [ ] **Step 3: Review and commit one clean runnable fixture source after approval**

Run only static checks before the commit:

```powershell
pnpm exec prettier --check apps/api/test/stage1-contract-archive.integration.spec.ts
git diff --check
git diff HEAD --name-only
git diff -- apps/api/test/stage1-contract-archive.integration.spec.ts
git add -- apps/api/test/stage1-contract-archive.integration.spec.ts
git diff --cached --check
git diff --cached --name-only
git diff HEAD --name-only
git diff HEAD -- apps/api/test/stage1-contract-archive.integration.spec.ts
git commit -m "test: align B3 journey fixture identity"
git status --short
git rev-parse HEAD
```

Expected: both `git diff HEAD` inspections and the staged-path check show only the Task 3R fixture edit above; there is no manifest or product/schema/shared-helper change. The commit succeeds, status is empty, and its full SHA becomes the new launch source. No database or unit test runs occur before this clean source boundary.

- [ ] **Step 4: Prepare generated code and rerun the four unchanged unit characterizations**

From that new clean source SHA, run these necessary local prerequisites and the original fixed unit selection:

```powershell
pnpm --filter @subscription-saas/shared build
pnpm prisma:generate
pnpm --filter @subscription-saas/api exec vitest run --project unit test/esign.spec.ts test/fadada-archive.spec.ts test/subscription-journey-esign.spec.ts test/lease-activation.spec.ts
```

Expected: each command exits `0`; all four selected files pass with `failed=0`, `skipped=0`, and `todo=0`. Record the actual test count. Any non-zero exit stops this B3 continuation before the database launcher; do not claim these commands were run during the document-revision round.

- [ ] **Step 5: Run and classify the complete three-case suite once**

Confirm `git status --short` is empty and `git rev-parse HEAD` is the newly reviewed fixture commit, then run the existing launcher interface exactly once:

```powershell
node scripts/release/run-database-suite.mjs --suite-id api.stage1-contract-archive.postgres --chain fresh
```

This is a full three-test fresh run, not a failed-test-only invocation. Do not add automatic retry, a cleanup/clean framework, a new launcher, a new interface, or an external JSON input.

For a complete `PASSED` result require exit `0`, `schemaVersion=database-suite-report.v1`, the existing suite/`fresh` identities, `terminalStatus=PASSED`, `collected=selected=executed=passed=3`, and `failed=skipped=todo=filtered=cancelled=0`. Also require `target.targetFingerprint` and the manifest/discovery/sanitized-log digests to have `sha256:` syntax; require `target.roleAttributes` to report `superuser=false`, `createdb=false`, `createrole=false`, and `bypassrls=false`; and require `target.canCreateSchema=false`, `target.schemaOwner=false`, and `target.objectOwner=false`.

For either a complete `PASSED` or complete `FAILED` report, independently read back the current launch's content-addressed report and matching custody receipt after the launcher returns. Compute the actual SHA-256 of both files; require the report-file digest to equal the receipt's `contentDigest` and `readbackDigest`, and require its `attestationRef` to bind the current `runId` and suite. Record the receipt ID/path and its actual file digest. Use only the launcher's existing local evidence/receipt files and fields.

A complete `FAILED` report with exit `1` is a governed test result, not automatically a launcher incident: verify that current report and custody binding first, then proceed only to Step 6 to record the actual counts and outcomes. A missing/incomplete report, `INTERRUPTED_UNKNOWN`, or custody/cleanup uncertainty is recorded from the actual run/incident information available; do not invent target fields, claim that all three cases executed, or manually delete retained resources. After any non-passing branch, stop all remaining B3 testing, fixes, and reruns, but still perform Step 6 evidence preservation. This B3 stop does not block other independently approved lines.

- [ ] **Step 6: Write a new evidence note without altering the first-run record**

Create `docs/acceptance/2026-09-07-stage1-b3-contract-archive-validation-rerun.md`. Record the fixture commit, clean launch source SHA, exact commands, unit result, terminal status, and only the run/operation/target/count/digest/custody identities actually observed. Every new value must come from this launch; do not reuse or overwrite first-run values. Mark any assertion not reached as `NOT_REACHED`; without a complete report, do not state that all three cases executed.

The note must reference the first run as immutable failed history, keep the same external/snapshot/B4 limitations, and avoid promotion language. Whether the new run passes or fails, preserve the first report, receipt, and acceptance note byte-for-byte. Then run:

```powershell
pnpm exec prettier --check docs/acceptance/2026-09-07-stage1-b3-contract-archive-validation-rerun.md
git diff --check
git diff HEAD --name-only
git diff HEAD -- docs/acceptance/2026-09-07-stage1-b3-contract-archive-validation-rerun.md
git add -- docs/acceptance/2026-09-07-stage1-b3-contract-archive-validation-rerun.md
git diff --cached --check
git diff --cached --name-only
git diff HEAD --name-only
git diff HEAD -- docs/acceptance/2026-09-07-stage1-b3-contract-archive-validation-rerun.md
git commit -m "docs: record Stage 1 B3 archive validation rerun"
```

Expected: the only evidence diff and staged path is the new rerun note. The historical note, canonical report, receipt, launcher, and manifest remain unchanged.

## Completion Criteria After an Approved Task 3R Execution

B3 is currently blocked. It becomes locally complete only after Task 3R is approved and all of the following are newly evidenced from one clean-source full run:

- the new PG file is manifested exactly once and discovery has no unclassified candidate;
- the shared build and Prisma generation prerequisites exit `0`, and the fixed four-file mock characterization command is newly green without edits;
- the fresh governed suite calls real ESign/archive/journey services and passes all three persistent tests;
- callback completion alone leaves Contract `SIGNED` with no archive admission facts;
- archive admission has a resolvable valid PDF FileObject and preserves ContractVersion and `signedAt`;
- duplicate/late callbacks, duplicate archive, and archive-first/repeated outbox dispatch converge to one authoritative transition;
- no Lease or VehicleSubscriptionPeriod is created or changed, and no provider network method is called;
- the evidence note contains current observed identities/counts/digests and the external/snapshot/B4 limitations; and
- no production, schema, migration, RBAC, flag, package, external-applicability, shared-index, or activation file changed.

Passing B3 is not real-provider acceptance, snapshot-chain acceptance, B4 activation proof, or release promotion.

---

### Task 3S: Correct the B3 Archive Successor Oracle and Produce Independent Transition Evidence

> **Approval gate:** Task 3S is a proposal pending explicit human approval. The current document-only authorization does not execute any step below.
>
> **Sequential STOP rule:** After approval, run every command one at a time in the stated order and check its exit/status before continuing. Any unexpected path or non-zero static/unit/prerequisite result stops before fresh execution. A complete counted `FAILED` run or an incomplete/unknown run permits only custody/incident readback and truthful evidence closeout, never another B3 test/code change or retry.

**Files:**

- Modify exactly one expression: `apps/api/test/stage1-contract-archive.integration.spec.ts:758`
- Create only after one approved fresh invocation: `docs/acceptance/2026-09-07-stage1-b3-contract-archive-transition-validation.md`
- Read only: both existing B3 acceptance notes, both failed reports and receipts, the six fixed unit files, product/design sources, manifest, and existing launcher

**Interfaces:**

- Replace only `SubscriptionJourneyStepCode.CUSTOMER_JSAPI_PAYMENT` in the existing third-case `currentStepCode` expectation with the literal `SubscriptionJourneyStepCode.INITIAL_BILLING`.
- Do not derive the expectation by calling `nextStep`, add any assertion (including an optional job/status assertion), edit another byte/test body/transaction/ID/key, or run a worker, billing, payment, or activation path to force the old oracle.
- The existing late-signal dispatches remain unchanged. Their stable current-step key may enqueue one `GENERATE_INITIAL_BILLS` job; this test does not execute that job, and Task 3S does not claim all late signals are ignored.

- [ ] **Step 1: Establish the independently approved, clean, non-database boundary**

Run in one PowerShell session after this plan amendment has been independently committed and approved:

```powershell
$planPath = 'docs/superpowers/plans/2026-09-06-stage1-b3-contract-archive-validation-plan.md'
$newEvidencePath = 'docs/acceptance/2026-09-07-stage1-b3-contract-archive-transition-validation.md'
$statusBefore = @(git status --short)
$task3sPlanSha = (git rev-parse HEAD).Trim()
$planCommitPaths = @(git diff-tree --no-commit-id --name-only -r HEAD)
$task3sStashBefore = @(git stash list --format='%gd %H')
if ($statusBefore.Count -ne 0) { throw "TASK3S_SOURCE_DIRTY" }
if ($planCommitPaths.Count -ne 1 -or $planCommitPaths[0] -ne $planPath) {
  throw "TASK3S_PLAN_NOT_INDEPENDENT_COMMIT: $($planCommitPaths -join ',')"
}
if (Test-Path -LiteralPath $newEvidencePath) {
  throw "TASK3S_EVIDENCE_PATH_ALREADY_EXISTS"
}
$ambientDatabaseNames = @(
  Get-ChildItem Env: |
    Where-Object { $_.Name -in @('DATABASE_URL', 'DIRECT_URL', 'SHADOW_DATABASE_URL', 'TEST_DATABASE_URL') } |
    Select-Object -ExpandProperty Name
)
if ($ambientDatabaseNames.Count -ne 0) {
  throw "TASK3S_AMBIENT_DATABASE_ENV_PRESENT: $($ambientDatabaseNames -join ',')"
}
$fixedPaths = @(
  '.release-local/controlled-target.v1.json',
  '.release-local/secrets/bootstrap.json',
  '.release-local/secrets/migrate.json',
  '.release-local/secrets/verify.json',
  '.release-local/secrets/runtime-test.json'
)
$presentFixedPaths = @($fixedPaths | Where-Object { Test-Path -LiteralPath $_ })
if ($presentFixedPaths.Count -ne 0) {
  throw "TASK3S_RETIRED_FIXED_PATH_PRESENT: $($presentFixedPaths -join ',')"
}
$immutableHashes = [ordered]@{
  'docs/acceptance/2026-09-06-stage1-b3-contract-archive-validation.md' = 'bbcad66c3eb5c0918285123c8c69bab74ae8ffaac171b7a5e778a7fb7d9008a4'
  'docs/acceptance/2026-09-07-stage1-b3-contract-archive-validation-rerun.md' = '3354b626918721ac166b747b265e04b9a6c59b5e005c6e219f46b0a2923b951e'
  '.release-local/evidence/evidence/623c488b4c59990aa5e283de2318203009694612bcc7e7281d7c7a0f136342e9.json' = '623c488b4c59990aa5e283de2318203009694612bcc7e7281d7c7a0f136342e9'
  '.release-local/evidence/receipts/ed43e6ed-e06b-458e-b9ba-2eafbea8e1b5.json' = '200f9d312b26d5076070d8719b43af263bdc6853642dcb40085b006f69744110'
  '.release-local/evidence/evidence/3d81ca096b36c2619cc6e4ef27fcd495e8b55761aadb38dc0ab87b79bbd240ab.json' = '3d81ca096b36c2619cc6e4ef27fcd495e8b55761aadb38dc0ab87b79bbd240ab'
  '.release-local/evidence/receipts/24d18dfc-fb4a-437c-b17e-fbb277f1c43b.json' = '53ad0418ee000985e002c143a1e41883fdc95282ae489cbb7c5ac388d716ee46'
}
foreach ($entry in $immutableHashes.GetEnumerator()) {
  $actual = (Get-FileHash -LiteralPath $entry.Key -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $entry.Value) { throw "TASK3S_IMMUTABLE_HASH_MISMATCH: $($entry.Key)" }
}
```

Expected: clean committed plan source, exactly the plan in its latest commit, absent new evidence path, no named ambient database variable, all five fixed paths absent, and all six immutable evidence hashes exact. Read only environment/path names, not credential contents. Do not run `prisma migrate status` or any ambient database query in this preflight. Do not create, apply, or drop a stash.

- [ ] **Step 2: Make only the literal successor-oracle replacement**

Apply exactly:

```diff
-    expect(journeyAfter.currentStepCode).toBe(SubscriptionJourneyStepCode.CUSTOMER_JSAPI_PAYMENT);
+    expect(journeyAfter.currentStepCode).toBe(SubscriptionJourneyStepCode.INITIAL_BILLING);
```

Do not import or call `nextStep`; do not add a queued-job/status assertion. Preserve all other test bytes, the transaction/dispatch order, fixtures, IDs, event keys, and assertions.

- [ ] **Step 3: Prove the one-expression diff, stage only it, and commit a clean source**

Run sequentially:

```powershell
pnpm exec prettier --check apps/api/test/stage1-contract-archive.integration.spec.ts
git diff --check
git diff HEAD --name-only
git diff HEAD -- apps/api/test/stage1-contract-archive.integration.spec.ts
git add -- apps/api/test/stage1-contract-archive.integration.spec.ts
git diff --cached --check
git diff --cached --name-only
git diff --name-only
git diff HEAD --name-only
git diff --cached -- apps/api/test/stage1-contract-archive.integration.spec.ts
```

Expected before review: every path listing that includes committed/staged changes contains exactly `apps/api/test/stage1-contract-archive.integration.spec.ts`, the unstaged listing after `git add` is empty, and the cached diff is exactly the replacement in Step 2. Pause here for a read-only independent-agent review and main-agent review of the one-line cached diff. Either reviewer rejecting the boundary stops Task 3S before commit, units, or fresh execution.

Only after both reviews accept the exact cached diff, run:

```powershell
git commit -m "test: correct B3 archive successor expectation"
git status --short
$task3sSourceSha = (git rev-parse HEAD).Trim()
if (@(Compare-Object $task3sStashBefore @(git stash list --format='%gd %H')).Count -ne 0) {
  throw "TASK3S_STASH_CHANGED"
}
```

Expected after commit: status is empty and `$task3sSourceSha` is the actual full launch-source SHA—not a placeholder. No test or database command precedes this boundary.

- [ ] **Step 4: Build/generate, then run the fixed six-file unit selection**

From `$task3sSourceSha`, run each command separately and stop before fresh execution on any non-zero exit:

```powershell
pnpm --filter @subscription-saas/shared build
pnpm prisma:generate
pnpm --filter @subscription-saas/api exec vitest run --project unit test/esign.spec.ts test/fadada-archive.spec.ts test/subscription-journey-esign.spec.ts test/lease-activation.spec.ts test/subscription-journey-state-machine.spec.ts test/subscription-journey-payment.spec.ts
git status --short
git rev-parse HEAD
```

Expected: build and generation exit `0`; all selected tests pass with `failed=skipped=todo=0`; status remains empty and HEAD equals `$task3sSourceSha`. Record actual file/test counts, duration, Node/pnpm/Prisma versions, and explicitly state that the two added read-only selections are `subscription-journey-state-machine.spec.ts` and `subscription-journey-payment.spec.ts`; there is no suite or manifest change. Node 24 output is local characterization, not Node 22 final-image evidence. On failure, report the observed result and `fresh=NOT_RUN`; do not create the reserved evidence note because no fresh invocation occurred.

- [ ] **Step 5: Invoke the existing complete fresh suite exactly once and classify its stdout report first**

Keep the same PowerShell session. Inventory receipt filenames only, then invoke the existing launcher once:

```powershell
$suiteId = 'api.stage1-contract-archive.postgres'
$evidenceRoot = Join-Path (Get-Location) '.release-local/evidence'
$receiptRoot = Join-Path $evidenceRoot 'receipts'
$beforeReceiptNames = @()
if (Test-Path -LiteralPath $receiptRoot) {
  $beforeReceiptNames = @(
    Get-ChildItem -LiteralPath $receiptRoot -File | Select-Object -ExpandProperty Name
  )
}
$stdout = @(
  & node scripts/release/run-database-suite.mjs --suite-id $suiteId --chain fresh
)
$suiteExit = $LASTEXITCODE
$afterReceiptNames = @()
if (Test-Path -LiteralPath $receiptRoot) {
  $afterReceiptNames = @(
    Get-ChildItem -LiteralPath $receiptRoot -File | Select-Object -ExpandProperty Name
  )
}
$newReceiptNames = @($afterReceiptNames | Where-Object { $_ -notin $beforeReceiptNames })
$stdoutJson = $stdout -join ''
$report = $null
$reportParseError = $null
try { $report = $stdoutJson | ConvertFrom-Json -ErrorAction Stop } catch {
  $reportParseError = $_.Exception.Message
}
$countedPassed = (
  $suiteExit -eq 0 -and
  $null -ne $report -and
  $report.schemaVersion -eq 'database-suite-report.v1' -and
  $report.suiteId -eq $suiteId -and
  $report.chain -eq 'fresh' -and
  $report.terminalStatus -eq 'PASSED' -and
  $report.counts.collected -eq 3 -and $report.counts.selected -eq 3 -and
  $report.counts.executed -eq 3 -and $report.counts.passed -eq 3 -and
  $report.counts.failed -eq 0 -and $report.counts.skipped -eq 0 -and
  $report.counts.todo -eq 0 -and $report.counts.filtered -eq 0 -and
  $report.counts.cancelled -eq 0
)
$countedFailed = (
  $suiteExit -eq 1 -and
  $null -ne $report -and
  $report.schemaVersion -eq 'database-suite-report.v1' -and
  $report.suiteId -eq $suiteId -and
  $report.chain -eq 'fresh' -and
  $report.terminalStatus -eq 'FAILED' -and
  $report.counts.collected -eq 3 -and $report.counts.selected -eq 3 -and
  $report.counts.executed -eq 3 -and $report.counts.failed -gt 0 -and
  ($report.counts.passed + $report.counts.failed) -eq 3 -and
  $report.counts.skipped -eq 0 -and $report.counts.todo -eq 0 -and
  $report.counts.filtered -eq 0 -and $report.counts.cancelled -eq 0
)
$runClassification = if ($countedPassed) { 'PASSED' } elseif ($countedFailed) { 'FAILED' } else { 'UNKNOWN_OR_INCOMPLETE' }
[pscustomobject]@{
  sourceSha = $task3sSourceSha
  suiteExit = $suiteExit
  classification = $runClassification
  reportParseError = $reportParseError
  newReceiptNames = $newReceiptNames
  report = $report
} | ConvertTo-Json -Depth 8
```

This is the only Task 3S database invocation: do not repeat a red fresh run. A complete counted `FAILED` report is governed failure evidence, not success; proceed only to custody verification and Step 7 closeout. `UNKNOWN_OR_INCOMPLETE`, `INTERRUPTED_UNKNOWN`, missing report, or cleanup/custody uncertainty remains an incident using only actual emitted identities—do not invent missing facts, manually clean a retained target, or retry.

- [ ] **Step 6: Bind a complete counted report to the one new receipt and actual stored bytes**

Only when `$countedPassed -or $countedFailed`, verify custody after the report classification. The launcher stdout does not return the receipt, so use the filename difference captured in Step 5:

```powershell
if (-not ($countedPassed -or $countedFailed)) {
  throw "TASK3S_NO_COMPLETE_COUNTED_REPORT; RECORD_INCIDENT_ONLY"
}
if ($newReceiptNames.Count -ne 1) {
  throw "TASK3S_CURRENT_RECEIPT_IDENTITY_AMBIGUOUS: $($newReceiptNames -join ',')"
}
$digestPattern = '^sha256:[0-9a-f]{64}$'
$receiptNameId = [IO.Path]::GetFileNameWithoutExtension($newReceiptNames[0])
[guid]$receiptNameGuid = [guid]::Empty
[guid]$reportRunGuid = [guid]::Empty
[guid]$reportOperationGuid = [guid]::Empty
$receiptNameGuidValid = [guid]::TryParseExact($receiptNameId, 'D', [ref]$receiptNameGuid)
$reportRunGuidValid = [guid]::TryParseExact([string]$report.runId, 'D', [ref]$reportRunGuid)
$reportOperationGuidValid = [guid]::TryParseExact([string]$report.operationId, 'D', [ref]$reportOperationGuid)
$stdoutIdentityMismatch = @(
  @(
    (-not $receiptNameGuidValid)
    ([IO.Path]::GetExtension($newReceiptNames[0]) -cne '.json')
    (-not $reportRunGuidValid)
    (-not $reportOperationGuidValid)
    ($report.manifestDigest -cnotmatch $digestPattern)
    ($report.discoveryDigest -cnotmatch $digestPattern)
    ($report.sanitizedLogDigest -cnotmatch $digestPattern)
    ($report.target.targetFingerprint -cnotmatch $digestPattern)
    ([string]::IsNullOrWhiteSpace([string]$report.target.databaseName))
    ([string]$report.target.databaseOid -cnotmatch '^[0-9]+$')
    ($report.target.roleAttributes.superuser -ne $false)
    ($report.target.roleAttributes.createdb -ne $false)
    ($report.target.roleAttributes.createrole -ne $false)
    ($report.target.roleAttributes.bypassrls -ne $false)
    ($report.target.canCreateSchema -ne $false)
    ($report.target.schemaOwner -ne $false)
    ($report.target.objectOwner -ne $false)
  ) | Where-Object { $_ }
)
if ($stdoutIdentityMismatch.Count -ne 0) {
  throw "TASK3S_STDOUT_OR_RECEIPT_FILENAME_IDENTITY_INVALID"
}
$receiptPath = Join-Path $receiptRoot $newReceiptNames[0]
$receiptRaw = Get-Content -LiteralPath $receiptPath -Raw
$receipt = $receiptRaw | ConvertFrom-Json
[guid]$receiptGuid = [guid]::Empty
$receiptGuidValid = [guid]::TryParseExact([string]$receipt.receiptId, 'D', [ref]$receiptGuid)
$expectedAttestation = "local-controlled-nonpromotable://$($report.runId)/$suiteId"
$receiptIdentityMismatch = @(
  @(
    ($receipt.schemaVersion -ne 'custody-receipt.v1')
    (-not $receiptGuidValid)
    ($receipt.receiptId -ne $receiptNameId)
    ($receipt.attestationRef -ne $expectedAttestation)
    ($receipt.contentDigest -cnotmatch $digestPattern)
    ($receipt.readbackDigest -cnotmatch $digestPattern)
  ) | Where-Object { $_ }
)
if ($receiptIdentityMismatch.Count -ne 0) {
  throw "TASK3S_CURRENT_RECEIPT_IDENTITY_INVALID"
}
$reportDigestName = $receipt.contentDigest.Substring('sha256:'.Length)
$reportPath = Join-Path $evidenceRoot (
  'evidence/' + $reportDigestName + '.json'
)
$expectedStoreRef = "local-controlled-nonpromotable://evidence/$reportDigestName.json"
$storedRaw = Get-Content -LiteralPath $reportPath -Raw
$storedReport = $storedRaw | ConvertFrom-Json
$reportSizeBytes = (Get-Item -LiteralPath $reportPath).Length
$reportFileDigest = 'sha256:' + (Get-FileHash -LiteralPath $reportPath -Algorithm SHA256).Hash.ToLowerInvariant()
$receiptFileDigest = 'sha256:' + (Get-FileHash -LiteralPath $receiptPath -Algorithm SHA256).Hash.ToLowerInvariant()
$countKeys = @('cancelled', 'collected', 'executed', 'failed', 'filtered', 'passed', 'selected', 'skipped', 'todo')
$countMismatch = @($countKeys | Where-Object { $storedReport.counts.$_ -ne $report.counts.$_ })
$bindingMismatch = @(
  @(
    ($receipt.storeRef -ne $expectedStoreRef)
    ($receipt.contentSizeBytes -ne $reportSizeBytes)
    ($receipt.contentDigest -ne $receipt.readbackDigest)
    ($receipt.contentDigest -ne $reportFileDigest)
    ($storedReport.schemaVersion -ne 'database-suite-report.v1')
    ($storedReport.runId -ne $report.runId)
    ($storedReport.operationId -ne $report.operationId)
    ($storedReport.suiteId -ne $report.suiteId)
    ($storedReport.chain -ne $report.chain)
    ($storedReport.terminalStatus -ne $report.terminalStatus)
    ($storedReport.manifestDigest -ne $report.manifestDigest)
    ($storedReport.discoveryDigest -ne $report.discoveryDigest)
    ($storedReport.sanitizedLogDigest -ne $report.sanitizedLogDigest)
    ($storedReport.target.databaseName -ne $report.target.databaseName)
    ($storedReport.target.databaseOid -ne $report.target.databaseOid)
    ($storedReport.target.targetFingerprint -ne $report.target.targetFingerprint)
    ($storedReport.target.roleAttributes.superuser -ne $report.target.roleAttributes.superuser)
    ($storedReport.target.roleAttributes.createdb -ne $report.target.roleAttributes.createdb)
    ($storedReport.target.roleAttributes.createrole -ne $report.target.roleAttributes.createrole)
    ($storedReport.target.roleAttributes.bypassrls -ne $report.target.roleAttributes.bypassrls)
    ($storedReport.target.canCreateSchema -ne $report.target.canCreateSchema)
    ($storedReport.target.schemaOwner -ne $report.target.schemaOwner)
    ($storedReport.target.objectOwner -ne $report.target.objectOwner)
    ($countMismatch.Count -ne 0)
  ) | Where-Object { $_ }
)
if ($bindingMismatch.Count -ne 0) { throw "TASK3S_CURRENT_REPORT_RECEIPT_MISMATCH" }
$currentRunPath = Join-Path (Get-Location) ".release-local/runs/$($report.runId)"
if (Test-Path -LiteralPath $currentRunPath) {
  throw "TASK3S_CURRENT_RUN_NOT_RETIRED: $currentRunPath"
}
[pscustomobject]@{
  reportPath = $reportPath
  reportFileDigest = $reportFileDigest
  receiptPath = $receiptPath
  receiptFileDigest = $receiptFileDigest
  receiptId = $receipt.receiptId
  receiptSchemaVersion = $receipt.schemaVersion
  storeRef = $receipt.storeRef
  contentSizeBytes = $receipt.contentSizeBytes
  contentDigest = $receipt.contentDigest
  readbackDigest = $receipt.readbackDigest
  attestationRef = $receipt.attestationRef
  runId = $report.runId
  operationId = $report.operationId
  suiteId = $report.suiteId
  terminalStatus = $report.terminalStatus
  counts = $report.counts
} | ConvertTo-Json -Depth 5
```

Both report and receipt file hashes are independently computed. The report hash must equal the receipt's actual `contentDigest` and `readbackDigest`; the stored report must repeat the exact stdout run/operation/suite/chain/status/counts and manifest/discovery/log digests; the attestation must bind the exact current run and suite. A custody/readback mismatch becomes an actual incident and permits only Step 7 closeout. Do not inspect target credentials or read any future target secret.

- [ ] **Step 7: Record only observed transition evidence and commit only that note**

After the single fresh invocation, create `docs/acceptance/2026-09-07-stage1-b3-contract-archive-transition-validation.md`. Record the actual Task 3S source SHA; exact commands; build/generate and six-file unit results; Node/pnpm/Prisma versions; fresh exit/classification; and only emitted `runId`, `operationId`, target fields, all nine counts, manifest/discovery/sanitized-log digests, report/receipt paths and both file hashes, receipt ID/content/readback digests, exact run/suite `attestationRef`, and cleanup state. For a complete `FAILED` result record the exact failed test, expected/actual facts, and mark later assertions `NOT_REACHED`; for a missing/unknown report retain the actual incident and mark unavailable fields `UNKNOWN`/`NOT_EMITTED`, never fabricated. Failure evidence is permitted only as closeout and does not authorize further B3 test/code work.

Preserve both earlier notes, both reports, and both receipts byte-for-byte; do not reclassify or overwrite them. Retain the Node 24/not-Node-22 caveat, minimal-PDF/deterministic-provider limits, snapshot not run, B4/B5 not executed, `stage1.esign=must-external-verify`, and no external or promotion claim. Then run sequentially:

```powershell
pnpm exec prettier --check docs/acceptance/2026-09-07-stage1-b3-contract-archive-transition-validation.md
git diff --check
git diff HEAD --name-only
git diff HEAD -- docs/acceptance/2026-09-07-stage1-b3-contract-archive-transition-validation.md
git add -- docs/acceptance/2026-09-07-stage1-b3-contract-archive-transition-validation.md
git diff --cached --check
git diff --cached --name-only
git diff --name-only
git diff HEAD --name-only
git diff --cached -- docs/acceptance/2026-09-07-stage1-b3-contract-archive-transition-validation.md
foreach ($entry in $immutableHashes.GetEnumerator()) {
  $actual = (Get-FileHash -LiteralPath $entry.Key -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $entry.Value) { throw "TASK3S_IMMUTABLE_HASH_MISMATCH: $($entry.Key)" }
}
if (@(Compare-Object $task3sStashBefore @(git stash list --format='%gd %H')).Count -ne 0) {
  throw "TASK3S_STASH_CHANGED"
}
```

Expected before review: the unstaged listing after `git add` is empty; every staged/HEAD path listing contains only the new note; cached diff checks cover the actual staged bytes; immutable hashes and stash snapshot are unchanged. Pause here for a read-only independent-agent review and main-agent review of the complete evidence/custody closeout. A review failure stops before the evidence commit and never authorizes a fresh retry or further B3 test/code action.

Only after both reviews accept the staged evidence-only closeout, run:

```powershell
git commit -m "docs: record B3 archive transition validation"
git status --short
git rev-parse HEAD
```

Expected after commit: status is empty.

## Task 3S Exit Criteria

B3 becomes locally complete only if the separately approved Task 3S execution uses one clean committed source, all shared-build/generation and fixed six-file unit gates pass, the sole complete fresh run reports exact 3/3 `PASSED`, custody/readback binds the actual report, every existing third-case assertion passes, and the independent note is committed alone. The corrected successor must be literal `INITIAL_BILLING`; no worker/billing/payment execution or new assertion is part of that proof.

Any unit/prerequisite failure leaves fresh `NOT_RUN`. Any complete `FAILED` or unknown/incomplete fresh outcome leaves B3 blocked after evidence-only closeout and requires a separate future approval for any further test/code action. Task 30, real Fadada/OSS, renderable/supplier-valid PDF proof, snapshot validation, B4/B5, Node 22 final-image evidence, external promotion, and release promotion remain outside Task 3S and frozen by their own gates.
