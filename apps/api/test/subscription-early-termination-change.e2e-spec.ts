import { ConfigService } from "@nestjs/config";
import {
  ContractStatus,
  Prisma,
  SubscriptionChangeStatus,
  SubscriptionChangeType
} from "@prisma/client";
import { PermissionCode } from "@subscription-saas/shared";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AssetAccountingRepository } from "../src/asset-accounting/asset-accounting.repository";
import { AssetAccountingService } from "../src/asset-accounting/asset-accounting.service";
import { AssetFactsRepository } from "../src/asset-facts/asset-facts.repository";
import { AssetFactsService } from "../src/asset-facts/asset-facts.service";
import { AssetOperationsRepository } from "../src/asset-operations/asset-operations.repository";
import { AssetOperationsService } from "../src/asset-operations/asset-operations.service";
import { AuditService } from "../src/audit/audit.service";
import { HandoverWorkOrderService } from "../src/handover-work-order/handover-work-order.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { SubscriptionChangeConfig } from "../src/subscription-change/subscription-change.config";
import { SubscriptionEarlyTerminationChangeService } from "../src/subscription-change/subscription-early-termination-change.service";
import { SubscriptionClosureRepository } from "../src/subscription-closure/subscription-closure.repository";
import { SubscriptionClosureService } from "../src/subscription-closure/subscription-closure.service";
import { VehicleMileageRepository } from "../src/vehicle-mileage/vehicle-mileage.repository";
import { VehicleMileageService } from "../src/vehicle-mileage/vehicle-mileage.service";
import { requiredReleaseDatabaseTestContext } from "./helpers/release-database-test-context";
import { insertRuntimeContract, insertRuntimeOrderGraph } from "./helpers/runtime-domain-fixture";

const TEST_DATABASE_URL = requiredReleaseDatabaseTestContext(
  "apps/api/test/subscription-early-termination-change.e2e-spec.ts"
).databaseUrl;

describe("early termination V2 change center with Closure authority", () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(new ConfigService({ DATABASE_URL: TEST_DATABASE_URL }));
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  it("cancels before execution and executes a later change without stopping billing early", async () => {
    const fixture = await createFixture(prisma);
    const { audit, closure } = createClosure(prisma);
    let applicationNow = await databaseClock(prisma);
    const config: SubscriptionChangeConfig = {
      enabled: true,
      now: () => applicationNow,
      quoteValidityHours: 72
    };
    const artifactWriter = {
      writeGeneratedContractPdfArtifact: async (input: { renderModel: { contractId: string } }) => {
        const objectKey = `contracts/${input.renderModel.contractId}/generated/early-termination.pdf`;
        const file = await prisma.fileObject.create({
          data: {
            bucket: "test-contracts",
            mimeType: "application/pdf",
            objectKey,
            originalName: "early-termination.pdf",
            sizeBytes: 128n,
            uploadedBy: fixture.actorId
          }
        });
        return {
          bucket: file.bucket,
          diagnostics: {},
          fileId: file.id,
          mimeType: "application/pdf",
          objectKey,
          originalName: file.originalName,
          sizeBytes: 128
        };
      }
    };
    const service = new SubscriptionEarlyTerminationChangeService(
      prisma,
      closure,
      audit,
      config,
      artifactWriter as never,
      new ConfigService()
    );
    const actor = {
      id: fixture.actorId,
      menus: [],
      name: "Early termination operator",
      permissions: [
        PermissionCode.SUBSCRIPTION_CHANGE_CANCEL,
        PermissionCode.SUBSCRIPTION_CHANGE_EXECUTE,
        PermissionCode.SUBSCRIPTION_CHANGE_QUOTE,
        PermissionCode.SUBSCRIPTION_CHANGE_SUBMIT,
        PermissionCode.CONTRACT_GENERATE
      ],
      roles: ["SYSTEM_ADMIN"],
      username: fixture.username
    };
    const context = { ipAddress: "127.0.0.1", userAgent: "vitest-e2e" };
    try {
      const cancellable = await createDraftChange(prisma, fixture, fixture.tomorrowDate);
      const estimated = await service.createEstimate(
        cancellable.id,
        { idempotencyKey: "b8-estimate", version: 0 },
        actor,
        context
      );
      expect(estimated.estimate.futureBillBoundary).toMatchObject({
        billIds: [fixture.futureBillId],
        cancelOnlyAtExecution: true
      });
      await service.publishCustomerConfirmation(
        cancellable.id,
        { idempotencyKey: "b8-publish", version: 1 },
        actor,
        context
      );
      await service.decide(
        cancellable.id,
        {
          decision: "ACCEPT",
          idempotencyKey: "b8-accept",
          quoteId: cancellable.id,
          revision: estimated.estimate.revision,
          version: 2
        },
        { customerId: fixture.customerId },
        context
      );
      const agreement = await service.generate(
        cancellable.id,
        { idempotencyKey: "b8-generate", version: 3 },
        actor,
        context
      );
      await expect(
        service.generate(
          cancellable.id,
          { idempotencyKey: "b8-generate", version: 3 },
          actor,
          context
        )
      ).resolves.toMatchObject({ id: agreement.id, status: ContractStatus.GENERATED });
      await expect(
        prisma.subscriptionChangeOrder.findUniqueOrThrow({ where: { id: cancellable.id } })
      ).resolves.toMatchObject({
        status: SubscriptionChangeStatus.SIGNING_OR_PAYMENT,
        version: 4
      });
      await expect(billingTruth(prisma, fixture)).resolves.toMatchObject({
        billStatus: "PENDING",
        jobStatus: "PENDING",
        scheduleStatus: "ACTIVE"
      });

      await service.cancel(
        cancellable.id,
        { idempotencyKey: "b8-cancel", reason: "Customer withdrew request", version: 4 },
        actor,
        context
      );
      await expect(
        service.cancel(
          cancellable.id,
          { idempotencyKey: "b8-cancel", reason: "Customer withdrew request", version: 4 },
          actor,
          context
        )
      ).resolves.toMatchObject({ status: SubscriptionChangeStatus.CANCELLED, version: 5 });
      await expect(billingTruth(prisma, fixture)).resolves.toMatchObject({
        billStatus: "PENDING",
        jobStatus: "PENDING",
        scheduleStatus: "ACTIVE"
      });

      const executionClock = await databaseClock(prisma);
      const effectiveAt = new Date(executionClock.getTime() + 750);
      const initiated = await closure.initiateEarlyTermination({
        actorId: fixture.actorId,
        effectiveAt,
        evidence: [{ reference: "b8-execution-fixture", type: "CUSTOMER_REQUEST" }],
        idempotencyKey: "b8-direct-initiate",
        orderId: fixture.orderId,
        reason: "Customer confirmed governed early termination"
      });
      const executionChange = await createScheduledChange(prisma, fixture, {
        closureCaseId: initiated.closureCaseId
      });
      await expect(billingTruth(prisma, fixture)).resolves.toMatchObject({
        billStatus: "PENDING",
        jobStatus: "PENDING",
        scheduleStatus: "ACTIVE"
      });

      await waitForDatabaseClock(prisma, effectiveAt);
      applicationNow = await databaseClock(prisma);
      await expect(service.progress(executionChange.id)).resolves.toEqual({
        changeOrderId: executionChange.id,
        outcome: "EXECUTING"
      });
      const closureAgreement = await prisma.subscriptionClosureCurrentDocument.findUniqueOrThrow({
        include: {
          documentRevision: {
            include: {
              contractESignTask: true,
              signedFile: true,
              sourceFile: true
            }
          }
        },
        where: {
          closureCaseId_documentType: {
            closureCaseId: initiated.closureCaseId,
            documentType: "EARLY_TERMINATION_AGREEMENT"
          }
        }
      });
      expect(closureAgreement.documentRevision).toMatchObject({
        contractESignTask: {
          provider: "MOCK",
          signingStage: "STAGE3_SUBSCRIPTION_EXTENSION",
          taskStatus: "COMPLETED"
        },
        signedFile: { mimeType: "application/pdf" },
        sourceFile: { mimeType: "application/pdf" },
        stage: "ARCHIVED"
      });
      await expect(
        service.execute(
          executionChange.id,
          { idempotencyKey: "b8-execute", version: 0 },
          actor,
          context
        )
      ).resolves.toMatchObject({
        closureCaseId: initiated.closureCaseId,
        wrote: false
      });
      await expect(
        prisma.subscriptionChangeOrder.findUniqueOrThrow({ where: { id: executionChange.id } })
      ).resolves.toMatchObject({
        failureCode: null,
        status: SubscriptionChangeStatus.EXECUTING,
        version: 1
      });
      await expect(billingTruth(prisma, fixture)).resolves.toMatchObject({
        billStatus: "PENDING",
        jobStatus: "CANCELLED",
        scheduleStatus: "COMPLETED"
      });
      await expect(
        prisma.subscriptionClosureCase.findUniqueOrThrow({
          where: { id: initiated.closureCaseId }
        })
      ).resolves.toMatchObject({ status: "PREPARING_RETURN" });

      await markClosureOperationallyTerminated(prisma, initiated.closureCaseId, fixture.actorId);
      await expect(service.reconcile(executionChange.id)).resolves.toEqual({
        changeOrderId: executionChange.id,
        outcome: "COMPLETED"
      });
      await expect(
        prisma.subscriptionChangeOrder.findUniqueOrThrow({ where: { id: executionChange.id } })
      ).resolves.toMatchObject({ status: SubscriptionChangeStatus.COMPLETED, version: 2 });
    } finally {
      await cleanupFixture(prisma, fixture);
    }
  });

  it("moves a provider-backed agreement with current-fact drift to manual takeover without return leakage", async () => {
    const fixture = await createFixture(prisma);
    const { audit, closure } = createClosure(prisma);
    let applicationNow = await databaseClock(prisma);
    const service = new SubscriptionEarlyTerminationChangeService(
      prisma,
      closure,
      audit,
      {
        enabled: true,
        now: () => applicationNow,
        quoteValidityHours: 72
      },
      undefined,
      new ConfigService()
    );
    const actor = {
      id: fixture.actorId,
      menus: [],
      name: "Early termination operator",
      permissions: [
        PermissionCode.SUBSCRIPTION_CHANGE_CANCEL,
        PermissionCode.SUBSCRIPTION_CHANGE_EXECUTE
      ],
      roles: ["SYSTEM_ADMIN"],
      username: fixture.username
    };
    const context = { ipAddress: "127.0.0.1", userAgent: "vitest-e2e" };
    try {
      const effectiveAt = new Date(applicationNow.getTime() + 250);
      const initiated = await closure.initiateEarlyTermination({
        actorId: fixture.actorId,
        effectiveAt,
        evidence: [{ reference: "b8-provider-drift", type: "CUSTOMER_REQUEST" }],
        idempotencyKey: "b8-provider-drift-initiate",
        orderId: fixture.orderId,
        reason: "Customer confirmed governed early termination"
      });
      const change = await createScheduledChange(prisma, fixture, {
        closureCaseId: initiated.closureCaseId
      });
      const providerTask = await prisma.contractESignTask.findFirstOrThrow({
        where: {
          contractId: change.contractId!,
          signingStage: "STAGE3_SUBSCRIPTION_EXTENSION",
          taskStatus: "COMPLETED"
        }
      });
      await closure.archiveEarlyTerminationAgreement({
        actorId: fixture.actorId,
        agreementContractId: change.contractId!,
        closureCaseId: initiated.closureCaseId,
        idempotencyKey: `early-termination-change:${change.id}:agreement`,
        providerTaskId: providerTask.id
      });

      await prisma.vehicle.update({
        data: { status: "MAINTENANCE" },
        where: { id: fixture.vehicleId }
      });
      await waitForDatabaseClock(prisma, effectiveAt);
      applicationNow = await databaseClock(prisma);

      await expect(
        service.execute(
          change.id,
          { idempotencyKey: "b8-provider-drift-execute", version: 0 },
          actor,
          context
        )
      ).resolves.toMatchObject({
        closureCaseId: initiated.closureCaseId,
        outcome: "AGREEMENT_STALE"
      });
      await expect(
        prisma.subscriptionChangeOrder.findUniqueOrThrow({ where: { id: change.id } })
      ).resolves.toMatchObject({
        failureCode: "EARLY_TERMINATION_AGREEMENT_STALE",
        status: SubscriptionChangeStatus.MANUAL_TAKEOVER,
        version: 1
      });
      await expect(
        prisma.contractESignTask.findFirstOrThrow({
          where: {
            sourceId: initiated.closureCaseId,
            sourceType: "SUBSCRIPTION_EARLY_TERMINATION"
          }
        })
      ).resolves.toMatchObject({ taskStatus: "CANCELLED" });
      await expect(
        prisma.contractESignTask.findUniqueOrThrow({ where: { id: providerTask.id } })
      ).resolves.toMatchObject({ taskStatus: "COMPLETED" });
      await expect(
        prisma.vehicleReturn.count({ where: { orderId: fixture.orderId } })
      ).resolves.toBe(0);

      await expect(
        service.cancel(
          change.id,
          {
            idempotencyKey: "b8-provider-drift-cancel",
            reason: "Operator rejected the stale governed agreement",
            version: 1
          },
          actor,
          context
        )
      ).resolves.toMatchObject({ status: SubscriptionChangeStatus.CANCELLED, version: 2 });
      await expect(
        prisma.contract.findUniqueOrThrow({ where: { id: change.contractId! } })
      ).resolves.toMatchObject({ status: ContractStatus.ARCHIVED });
      await expect(
        prisma.vehicleReturn.count({ where: { orderId: fixture.orderId } })
      ).resolves.toBe(0);
    } finally {
      await cleanupFixture(prisma, fixture);
    }
  });
});

function createClosure(prisma: PrismaService) {
  const audit = new AuditService(prisma);
  const accounting = new AssetAccountingService(prisma, new AssetAccountingRepository(), audit);
  const operations = new AssetOperationsService(
    prisma,
    new AssetOperationsRepository(),
    audit,
    accounting
  );
  return {
    audit,
    closure: new SubscriptionClosureService(
      new SubscriptionClosureRepository(),
      new HandoverWorkOrderService(prisma, {} as never),
      operations,
      audit,
      prisma,
      new AssetFactsService(prisma, new AssetFactsRepository(), audit),
      accounting,
      new VehicleMileageService(prisma, new VehicleMileageRepository())
    )
  };
}

async function createDraftChange(
  prisma: PrismaService,
  fixture: EarlyTerminationFixture,
  effectiveDate: Date
) {
  return prisma.subscriptionChangeOrder.create({
    data: {
      changeNo: `CHG-B8-CANCEL-${randomUUID()}`,
      changeType: SubscriptionChangeType.EARLY_TERMINATION,
      completionDeadlineAt: fixture.futureEndDate,
      createdBy: fixture.actorId,
      earlyTerminationDetail: {
        create: {
          effectiveDate,
          reasonSnapshot: {
            evidence: [{ reference: "portal-request-b8", type: "CUSTOMER_REQUEST" }],
            reason: "Customer relocation"
          }
        }
      },
      orderId: fixture.orderId,
      sourceSegmentId: fixture.segmentId,
      status: SubscriptionChangeStatus.DRAFT,
      updatedBy: fixture.actorId
    }
  });
}

async function createScheduledChange(
  prisma: PrismaService,
  fixture: EarlyTerminationFixture,
  input: {
    closureCaseId: string;
  }
) {
  const changeOrderId = randomUUID();
  const sourceFile = await prisma.fileObject.create({
    data: {
      bucket: "test-contracts",
      mimeType: "application/pdf",
      objectKey: `contracts/${fixture.orderId}/generated/early-termination.pdf`,
      originalName: "generated-early-termination.pdf",
      sizeBytes: 192n,
      uploadedBy: fixture.actorId
    }
  });
  const signedFile = await prisma.fileObject.create({
    data: {
      bucket: "test-contracts",
      mimeType: "application/pdf",
      objectKey: `contracts/${fixture.orderId}/signed/early-termination.pdf`,
      originalName: "signed-early-termination.pdf",
      sizeBytes: 256n,
      uploadedBy: fixture.actorId
    }
  });
  const agreement = await prisma.contract.create({
    data: {
      archivedAt: new Date(),
      businessType: "SUBSCRIPTION",
      contractNo: `CON-B8-EXEC-${randomUUID()}`,
      contractSnapshot: {
        agreementFacts: {
          closureCaseId: input.closureCaseId,
          effectiveDate: fixture.todayDate.toISOString(),
          estimate: { revision: 1 },
          estimateRevision: 1,
          reason: "Customer confirmed governed early termination"
        },
        authority: "CUSTOMER_PROVIDER_ESIGN",
        changeOrderId,
        generatedPdfArtifact: {
          fileId: sourceFile.id,
          mimeType: sourceFile.mimeType,
          objectKey: sourceFile.objectKey
        },
        signedDocumentObjectKey: signedFile.objectKey
      },
      contractTitle: "B8 execution agreement",
      contractVersionId: fixture.contractVersionId,
      createdBy: fixture.actorId,
      customerId: fixture.customerId,
      fileId: signedFile.id,
      orderId: fixture.orderId,
      signedAt: new Date(),
      status: ContractStatus.ARCHIVED,
      updatedBy: fixture.actorId
    }
  });
  await prisma.contractESignTask.create({
    data: {
      completedAt: new Date(),
      contractId: agreement.id,
      createdBy: fixture.actorId,
      customerId: fixture.customerId,
      documentName: sourceFile.originalName,
      documentObjectKey: sourceFile.objectKey,
      documentType: "SUBSCRIPTION_EXTENSION_AGREEMENT",
      orderId: fixture.orderId,
      provider: "MOCK",
      providerEnvelopeId: `env-${randomUUID()}`,
      providerTaskId: `provider-${randomUUID()}`,
      signedDocumentObjectKey: signedFile.objectKey,
      signingStage: "STAGE3_SUBSCRIPTION_EXTENSION",
      sourceId: changeOrderId,
      sourceKey: `subscription-change:${changeOrderId}:esign:attempt:1`,
      sourceType: "EARLY_TERMINATION_SUPPLEMENT",
      taskNo: `ESG-B8-${randomUUID()}`,
      taskStatus: "COMPLETED",
      updatedBy: fixture.actorId
    }
  });
  return prisma.subscriptionChangeOrder.create({
    data: {
      id: changeOrderId,
      changeNo: `CHG-B8-EXEC-${randomUUID()}`,
      changeType: SubscriptionChangeType.EARLY_TERMINATION,
      completionDeadlineAt: fixture.futureEndDate,
      contractId: agreement.id,
      createdBy: fixture.actorId,
      earlyTerminationDetail: {
        create: {
          agreementContractId: agreement.id,
          closureCaseId: input.closureCaseId,
          effectiveDate: fixture.todayDate,
          estimatedSettlementRevision: 1,
          reasonSnapshot: {
            currentEstimate: { revision: 1 },
            reason: "Customer confirmed governed early termination"
          }
        }
      },
      orderId: fixture.orderId,
      sourceSegmentId: fixture.segmentId,
      status: SubscriptionChangeStatus.SCHEDULED,
      updatedBy: fixture.actorId
    }
  });
}

async function billingTruth(prisma: PrismaService, fixture: EarlyTerminationFixture) {
  const [bill, job, schedule] = await Promise.all([
    prisma.receivableBill.findUniqueOrThrow({ where: { id: fixture.futureBillId } }),
    prisma.subscriptionAutomationJob.findUniqueOrThrow({ where: { id: fixture.futureJobId } }),
    prisma.billingSchedule.findUniqueOrThrow({ where: { id: fixture.scheduleId } })
  ]);
  return {
    billStatus: bill.billStatus,
    jobStatus: job.jobStatus,
    scheduleStatus: schedule.status
  };
}

type EarlyTerminationFixture = Awaited<ReturnType<typeof createFixture>>;

async function createFixture(prisma: PrismaService) {
  const actorId = randomUUID();
  const contractId = randomUUID();
  const contractVersionId = randomUUID();
  const supplementContractVersionId = randomUUID();
  const customerId = randomUUID();
  const futureBillId = randomUUID();
  const futureJobId = randomUUID();
  const orderId = randomUUID();
  const scheduleId = randomUUID();
  const segmentId = randomUUID();
  const vehicleId = randomUUID();
  const username = `b8-${actorId}`;
  const now = await databaseClock(prisma);
  const todayDate = shanghaiBusinessDate(now, 0);
  const tomorrowDate = shanghaiBusinessDate(now, 1);
  const pastStartDate = shanghaiBusinessDate(now, -180);
  const futureEndDate = shanghaiBusinessDate(now, 180);
  const futurePeriodDate = shanghaiBusinessDate(now, 30);
  await prisma.$transaction(async (tx) => {
    await insertRuntimeOrderGraph(tx, {
      customerId,
      label: `B8-${orderId}`,
      orderId,
      salesUserId: actorId,
      vehicleId
    });
    await insertRuntimeContract(tx, {
      contractId,
      contractVersionId,
      customerId,
      label: `B8-${orderId}`,
      orderId,
      status: "SIGNED"
    });
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "contract_version" (
        "id", "template_name", "version_no", "business_type", "template_type", "content_template",
        "effective_from", "status", "created_at", "updated_at"
      ) VALUES (
        ${supplementContractVersionId}::uuid,
        ${`B8-SUP-${compact(supplementContractVersionId)}`},
        '1', 'SUBSCRIPTION', 'SUBSCRIPTION_EXTENSION', 'B8 early termination supplement',
        ${pastStartDate}::date, 'ACTIVE', clock_timestamp(), clock_timestamp()
      )
    `);
    await tx.subscriptionOrder.update({
      data: {
        actualDeliveryAt: now,
        createdBy: actorId,
        depositAmount: 500n,
        endDate: futureEndDate,
        finalPlanSnapshot: {},
        mileageLimitKm: 1500,
        monthlyFeeAmount: 100n,
        orderStatus: "ACTIVE",
        overMileageFeeAmount: 100n,
        periodMonths: 12,
        startDate: pastStartDate,
        updatedBy: actorId,
        vehiclePurchasePriceAmount: 20000000n
      },
      where: { id: orderId }
    });
    await tx.vehicle.update({
      data: { plateNo: `沪B${compact(vehicleId).slice(0, 5)}`, status: "LEASED" },
      where: { id: vehicleId }
    });
    await tx.contract.update({
      data: {
        contractSnapshot: { earlyTerminationFeeAmount: "300" },
        createdBy: actorId,
        updatedBy: actorId
      },
      where: { id: contractId }
    });
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "lease" ("id", "order_id", "status", "activated_at", "created_by", "updated_by", "created_at", "updated_at")
      VALUES (${randomUUID()}::uuid, ${orderId}::uuid, 'ACTIVE', clock_timestamp(), ${actorId}::uuid, ${actorId}::uuid, clock_timestamp(), clock_timestamp())
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "billing_schedule" (
        "id", "order_id", "status", "next_cycle_no", "next_period_start", "next_period_end",
        "next_generate_at", "created_at", "updated_at"
      ) VALUES (
        ${scheduleId}::uuid, ${orderId}::uuid, 'ACTIVE', 2, ${futurePeriodDate}::date,
        ${futureEndDate}::date, clock_timestamp(), clock_timestamp(), clock_timestamp()
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "subscription_contract_segment" (
        "id", "segment_no", "order_id", "segment_type", "sequence_no", "status", "start_date",
        "end_date", "monthly_fee_amount", "mileage_limit_km", "over_mileage_fee_amount",
        "plan_snapshot", "quote_snapshot", "contract_snapshot", "activated_at", "created_by", "created_at"
      ) VALUES (
        ${segmentId}::uuid, ${`SEGB8${compact(segmentId)}`}, ${orderId}::uuid, 'BASE', 1, 'ACTIVE',
        ${pastStartDate}::date, ${futureEndDate}::date, 100, 1500, 100, '{}'::jsonb, '{}'::jsonb,
        '{}'::jsonb, clock_timestamp(), ${actorId}::uuid, clock_timestamp()
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "receivable_bill" (
        "id", "bill_no", "order_id", "customer_id", "bill_type", "bill_status", "amount",
        "paid_amount", "remaining_amount", "due_date", "bill_period_start", "bill_period_end",
        "snapshot", "created_by", "created_at", "updated_at"
      ) VALUES (
        ${futureBillId}::uuid, ${`BILB8${compact(futureBillId)}`}, ${orderId}::uuid, ${customerId}::uuid,
        'MONTHLY_RENT', 'PENDING', 100, 0, 100, ${futurePeriodDate}::date, ${futurePeriodDate}::date,
        ${futureEndDate}::date, '{}'::jsonb, ${actorId}::uuid, clock_timestamp(), clock_timestamp()
      )
    `);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "subscription_automation_job" (
        "id", "billing_schedule_id", "order_id", "job_type", "job_status", "idempotency_key",
        "available_at", "payload", "created_at", "updated_at"
      ) VALUES (
        ${futureJobId}::uuid, ${scheduleId}::uuid, ${orderId}::uuid, 'GENERATE_MONTHLY_RENT_BILL',
        'PENDING', ${`b8-future:${futureJobId}`}, clock_timestamp(),
        ${JSON.stringify({ periodStart: dateOnly(futurePeriodDate) })}::jsonb,
        clock_timestamp(), clock_timestamp()
      )
    `);
  });
  return {
    actorId,
    contractId,
    contractVersionId,
    customerId,
    futureBillId,
    futureEndDate,
    futureJobId,
    orderId,
    scheduleId,
    segmentId,
    supplementContractVersionId,
    todayDate,
    tomorrowDate,
    username,
    vehicleId
  };
}

async function cleanupFixture(prisma: PrismaService, fixture: EarlyTerminationFixture) {
  // The release launcher destroys this suite's exact disposable database after evidence custody.
  void prisma;
  void fixture;
  return;
  await prisma.$transaction(async (tx) => {
    for (const table of [
      "audit_log",
      "contract_esign_callback_log",
      "subscription_closure_command_receipt",
      "subscription_closure_current_document",
      "subscription_closure_document_revision",
      "subscription_closure_event",
      "subscription_early_termination_change_detail",
      "subscription_change_order",
      "contract_esign_task",
      "subscription_closure_case",
      "vehicle_return_damage",
      "vehicle_return",
      "asset_work_order_event",
      "asset_work_order_evidence",
      "asset_work_order",
      "vehicle_handover_event",
      "vehicle_handover_work_order",
      "subscription_automation_job",
      "receivable_bill",
      "billing_schedule",
      "subscription_contract_segment",
      "lease"
    ]) {
      if (table === "audit_log") {
        await tx.$executeRawUnsafe(
          `DELETE FROM "${table}" WHERE "operator_id" = $1::uuid OR "entity_id" = $2::uuid`,
          fixture.actorId,
          fixture.orderId
        );
      } else if (table === "contract_esign_callback_log") {
        await tx.$executeRawUnsafe(
          `DELETE FROM "${table}" WHERE "task_id" IN (SELECT "id" FROM "contract_esign_task" WHERE "order_id" = $1::uuid)`,
          fixture.orderId
        );
      } else if (table.startsWith("subscription_closure_")) {
        const closureColumn =
          table === "subscription_closure_case" ? "order_id" : "closure_case_id";
        const clause =
          table === "subscription_closure_case"
            ? `"${closureColumn}" = $1::uuid`
            : `"${closureColumn}" IN (SELECT "id" FROM "subscription_closure_case" WHERE "order_id" = $1::uuid)`;
        await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE ${clause}`, fixture.orderId);
      } else if (table === "subscription_early_termination_change_detail") {
        await tx.$executeRawUnsafe(
          `DELETE FROM "${table}" WHERE "change_order_id" IN (SELECT "id" FROM "subscription_change_order" WHERE "order_id" = $1::uuid)`,
          fixture.orderId
        );
      } else if (table.startsWith("asset_work_order")) {
        const clause =
          table === "asset_work_order"
            ? `"order_id" = $1::uuid`
            : `"work_order_id" IN (SELECT "id" FROM "asset_work_order" WHERE "order_id" = $1::uuid)`;
        await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE ${clause}`, fixture.orderId);
      } else if (table.startsWith("vehicle_handover_")) {
        const clause =
          table === "vehicle_handover_work_order"
            ? `"order_id" = $1::uuid`
            : `"work_order_id" IN (SELECT "id" FROM "vehicle_handover_work_order" WHERE "order_id" = $1::uuid)`;
        await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE ${clause}`, fixture.orderId);
      } else {
        await tx.$executeRawUnsafe(
          `DELETE FROM "${table}" WHERE "order_id" = $1::uuid`,
          fixture.orderId
        );
      }
    }
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM "file_object" WHERE "uploaded_by" = ${fixture.actorId}::uuid`
    );
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM "contract" WHERE "order_id" = ${fixture.orderId}::uuid`
    );
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM "subscription_order" WHERE "id" = ${fixture.orderId}::uuid`
    );
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM "contract_version" WHERE "id" = ${fixture.contractVersionId}::uuid`
    );
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM "contract_version" WHERE "id" = ${fixture.supplementContractVersionId}::uuid`
    );
    await tx.$executeRaw(Prisma.sql`DELETE FROM "vehicle" WHERE "id" = ${fixture.vehicleId}::uuid`);
    await tx.$executeRaw(
      Prisma.sql`DELETE FROM "customer" WHERE "id" = ${fixture.customerId}::uuid`
    );
    await tx.$executeRaw(Prisma.sql`DELETE FROM "user" WHERE "id" = ${fixture.actorId}::uuid`);
  });
}

async function databaseClock(prisma: PrismaService) {
  const rows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
  if (!rows[0]) throw new Error("B8_DATABASE_CLOCK_MISSING");
  return rows[0].now;
}

async function markClosureOperationallyTerminated(
  prisma: PrismaService,
  closureCaseId: string,
  actorId: string
) {
  const repository = new SubscriptionClosureRepository();
  await prisma.$transaction(async (tx) => {
    for (const transition of [
      {
        afterStatus: "RETURN_INSPECTION" as const,
        eventType: "PHYSICAL_CONTROL_CONFIRMED" as const,
        expectedStatus: "PREPARING_RETURN" as const
      },
      {
        afterStatus: "PENDING_SETTLEMENT" as const,
        eventType: "INSPECTION_RECORDED" as const,
        expectedStatus: "RETURN_INSPECTION" as const
      },
      {
        afterStatus: "TERMINATED" as const,
        eventType: "STATUS_TRANSITIONED" as const,
        expectedStatus: "PENDING_SETTLEMENT" as const
      }
    ]) {
      if (transition.afterStatus === "TERMINATED") {
        await appendResolvedFixtureSettlement(tx, repository, closureCaseId, actorId);
      }
      const current = await tx.subscriptionClosureCase.findUniqueOrThrow({
        select: { status: true, version: true },
        where: { id: closureCaseId }
      });
      if (current.status !== transition.expectedStatus) {
        throw new Error("B8_CLOSURE_TERMINAL_FIXTURE_STATE_INVALID");
      }
      const occurredAt = await databaseClock(prisma);
      await repository.appendEvent(tx, {
        actorId,
        closureCaseId,
        detailSnapshot: { source: "early-termination-change-test" },
        occurredAt,
        source: {
          id: closureCaseId,
          key: `b8-test-terminal:${current.version}`,
          type: "SUBSCRIPTION_CLOSURE"
        },
        expectedVersion: current.version,
        ...transition
      });
    }
  });
}

async function appendResolvedFixtureSettlement(
  tx: Prisma.TransactionClient,
  repository: SubscriptionClosureRepository,
  closureCaseId: string,
  actorId: string
) {
  let currentRevisionId: string | null = null;
  let finalizedAt: Date | null = null;
  for (const stage of ["PROPOSED", "FINALIZED", "SETTLED"] as const) {
    const closureCase = await tx.subscriptionClosureCase.findUniqueOrThrow({
      select: { version: true },
      where: { id: closureCaseId }
    });
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`
      SELECT clock_timestamp() AS "now"
    `;
    if (!clock) throw new Error("B8_DATABASE_CLOCK_MISSING");
    const occurredAt = clock.now;
    if (stage === "FINALIZED") finalizedAt = occurredAt;
    const result = await repository.appendSettlementRevision(tx, {
      actorId,
      amountDueCents: 0n,
      amountRefundableCents: 0n,
      billInputSnapshot: { bills: [] },
      closureCaseId,
      costTotalCents: 0n,
      depositAppliedCents: 0n,
      depositInputSnapshot: { disposition: "PENDING" },
      depositRefundCents: 0n,
      expectedCurrentRevisionId: currentRevisionId,
      expectedVersion: closureCase.version,
      finalizedAt,
      finalizedBy: stage === "PROPOSED" ? null : actorId,
      ledgerInputSnapshot: { entries: [] },
      paidTotalCents: 0n,
      receivableTotalCents: 0n,
      responsibilitySnapshot: { parties: [] },
      resultSnapshot: { balanced: true },
      settledAt: stage === "SETTLED" ? occurredAt : null,
      settledBy: stage === "SETTLED" ? actorId : null,
      settlementType: "FINAL",
      source: {
        id: closureCaseId,
        key: `b8-test-settlement:${stage.toLowerCase()}`,
        type: "SUBSCRIPTION_CLOSURE"
      },
      stage,
      waiverApprovalId: null,
      waiverTotalCents: 0n,
      writeOffApprovalId: null,
      writeOffTotalCents: 0n
    });
    currentRevisionId = result.outcome.id;
  }
}

async function waitForDatabaseClock(prisma: PrismaService, target: Date) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if ((await databaseClock(prisma)).getTime() >= target.getTime()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("B8_DATABASE_CLOCK_DID_NOT_REACH_EFFECTIVE_TIME");
}

function shanghaiBusinessDate(now: Date, offsetDays: number) {
  const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1_000);
  return new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + offsetDays)
  );
}

function dateOnly(value: Date) {
  return value.toISOString().slice(0, 10);
}

function compact(value: string) {
  return value.replaceAll("-", "").slice(0, 20);
}
